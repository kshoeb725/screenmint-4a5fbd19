import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

function getKey(): string {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY is not configured.");
  return key;
}

async function chat(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("Rate limit hit. Please retry shortly.");
    if (res.status === 402) throw new Error("AI credits exhausted. Add funds in Workspace settings.");
    throw new Error(`AI gateway error ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ─── Vision analysis (Gemini flash) ──────────────────────────────────────────

async function analyzeImage(prompt: string, imageDataUrl: string): Promise<string> {
  const data = await chat({
    model: "google/gemini-2.5-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });
  return data?.choices?.[0]?.message?.content ?? "";
}

// ─── Image generation (Nano Banana) ──────────────────────────────────────────

async function generateImage(prompt: string): Promise<string> {
  const data = await chat({
    model: "google/gemini-2.5-flash-image",
    messages: [{ role: "user", content: prompt }],
    modalities: ["image", "text"],
  });
  const url = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error("Image generation returned no image.");
  return url;
}

// ─── Types ───────────────────────────────────────────────────────────────────

const InputSchema = z.object({
  imageDataUrl: z
    .string()
    .min(50)
    .refine((s) => s.startsWith("data:image/"), "Must be an image data URL"),
  email: z.string().trim().email().max(255),
  appName: z.string().trim().min(1).max(100),
  targetAudience: z.string().trim().min(1).max(300),
  objective: z.string().trim().min(1).max(500),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(8).optional().default([]),
  backgroundStyle: z.string().trim().max(200).optional().default(""),
});

type AnalysisPlan = {
  appName: string;
  category: string;
  primaryBenefit: string;
  shots: { headline: string; subhead: string; caption: string; imagePrompt: string }[];
};

function extractJSON(raw: string): string {
  let s = raw.replace(/^```json\s*/im, "").replace(/^```\s*/im, "").replace(/```\s*$/im, "").trim();
  if (!s.startsWith("{") && !s.startsWith("[")) {
    const o = s.indexOf("{");
    const a = s.indexOf("[");
    const isArr = a !== -1 && (o === -1 || a < o);
    const start = isArr ? a : o;
    const end = isArr ? s.lastIndexOf("]") : s.lastIndexOf("}");
    if (start !== -1 && end > start) s = s.slice(start, end + 1);
  }
  return s;
}

// ─── Analysis step ───────────────────────────────────────────────────────────

async function analyze(
  imageDataUrl: string,
  ctx: {
    appName: string;
    targetAudience: string;
    objective: string;
    palette: string[];
    backgroundStyle: string;
  },
): Promise<AnalysisPlan> {
  const paletteLine = ctx.palette.length ? ctx.palette.join(", ") : "vibrant brand colors";

  const prompt = `You are a Shopify App Store marketing expert. Analyze this screenshot of a Shopify merchant app and create a marketing plan for 3 promotional images.

App details (ground truth):
- App name: ${ctx.appName}
- Target audience: ${ctx.targetAudience}
- Main objective: ${ctx.objective}
- Brand colors: ${paletteLine}
- Background style: ${ctx.backgroundStyle || "clean modern"}

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "appName": "${ctx.appName}",
  "category": "one-word Shopify app category",
  "primaryBenefit": "compelling 8-12 word benefit statement",
  "shots": [
    { "headline": "...", "subhead": "...", "caption": "...", "imagePrompt": "detailed text-to-image prompt for a Shopify App Store hero promo image, 1600x1200, 4:3, device mockup of ${ctx.appName} with the headline overlay, palette ${paletteLine}, ${ctx.backgroundStyle || "clean modern"} background" },
    { "headline": "...", "subhead": "...", "caption": "...", "imagePrompt": "feature-callout promo for ${ctx.appName}, annotation pills, palette ${paletteLine}" },
    { "headline": "...", "subhead": "...", "caption": "...", "imagePrompt": "social-proof/results promo for ${ctx.appName} with a big stat card and merchant testimonial, palette ${paletteLine}" }
  ]
}`;

  const raw = await analyzeImage(prompt, imageDataUrl);
  const cleaned = extractJSON(raw);
  let parsed: AnalysisPlan;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("Malformed plan JSON. Raw:", raw.slice(0, 800));
    throw new Error("AI returned malformed plan. Please retry.");
  }
  if (!parsed?.shots || parsed.shots.length < 3) throw new Error("AI did not return 3 shots.");
  parsed.shots = parsed.shots.slice(0, 3);
  return parsed;
}

// ─── Image rendering step ────────────────────────────────────────────────────

async function renderShot(
  imagePrompt: string,
  headline: string,
  subhead: string,
  palette: string[],
  backgroundStyle: string,
): Promise<string> {
  const accent = palette[0] ?? "#C8E84A";
  const bg = palette[1] ?? "#F5F1E8";
  const paletteList = palette.length ? palette.join(", ") : "vibrant brand colors";

  const fullPrompt =
    `${imagePrompt}. ` +
    `Composition: 1600x1200px, 4:3 aspect ratio, professional Shopify App Store promotional image. ` +
    `Background color: ${bg}, palette: ${paletteList}, style: ${backgroundStyle || "clean modern"}. ` +
    `Overlay headline text: "${headline}". Supporting text: "${subhead}". ` +
    `Accent color: ${accent}. Ultra high quality, professional marketing graphic, no watermarks, no lorem ipsum.`;

  return generateImage(fullPrompt);
}

// ─── Server function ─────────────────────────────────────────────────────────

export const generatePromos = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }) => {
    const plan = await analyze(data.imageDataUrl, {
      appName: data.appName,
      targetAudience: data.targetAudience,
      objective: data.objective,
      palette: data.palette,
      backgroundStyle: data.backgroundStyle,
    });

    const images = await Promise.all(
      plan.shots.map((s) =>
        renderShot(s.imagePrompt, s.headline, s.subhead, data.palette, data.backgroundStyle).catch(
          (err) => ({ error: err instanceof Error ? err.message : "unknown" }),
        ),
      ),
    );

    const shots = plan.shots.map((s, i) => ({
      headline: s.headline,
      subhead: s.subhead,
      caption: s.caption,
      image: typeof images[i] === "string" ? (images[i] as string) : null,
      error: typeof images[i] === "string" ? null : (images[i] as { error: string }).error,
    }));

    try {
      const generated = shots.filter((s) => s.image).map((s) => s.image as string);
      await supabaseAdmin.from("submissions").insert({
        email: data.email,
        app_name: data.appName,
        target_audience: data.targetAudience,
        objective: data.objective,
        screenshot_ref: data.imageDataUrl.slice(0, 80) + "…",
        generated_images: generated,
        palette: data.palette,
        background_style: data.backgroundStyle,
      });
    } catch (err) {
      console.error("Failed to persist submission:", err);
    }

    return {
      appName: plan.appName,
      category: plan.category,
      primaryBenefit: plan.primaryBenefit,
      shots,
    };
  });
