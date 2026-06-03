import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";

// Latest high-quality text model optimized for content creation (supports vision).
const TEXT_MODEL = "gpt-4o";
// OpenAI's highest-quality image generation model.
const IMAGE_MODEL = "gpt-image-1";

function getKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured.");
  return key;
}

function mapError(status: number, text: string): Error {
  if (status === 401) return new Error("Invalid OpenAI API key. Please check the configured key.");
  if (status === 429) return new Error("Rate limit hit. Please retry shortly.");
  if (status === 402 || status === 403)
    return new Error("OpenAI quota exhausted or access denied. Check your OpenAI billing.");
  return new Error(`OpenAI error ${status}: ${text.slice(0, 300)}`);
}

async function chat(body: Record<string, unknown>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Network error contacting OpenAI: ${err instanceof Error ? err.message : "unknown"}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw mapError(res.status, text);
  }
  return res.json();
}

// ─── Vision analysis (OpenAI gpt-4o) ─────────────────────────────────────────

async function analyzeImage(prompt: string, imageDataUrl: string): Promise<string> {
  const data = await chat({
    model: TEXT_MODEL,
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

// ─── Image generation (OpenAI gpt-image-1) ───────────────────────────────────

async function generateImage(prompt: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(OPENAI_IMAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        n: 1,
        size: "1536x1024",
        quality: "high",
      }),
    });
  } catch (err) {
    throw new Error(`Network error contacting OpenAI: ${err instanceof Error ? err.message : "unknown"}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw mapError(res.status, text);
  }
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("Image generation returned no image.");
  return `data:image/png;base64,${b64}`;
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
  shots: { headline: string; subhead: string; imagePrompt: string }[];
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

  const prompt = `You are a Shopify App Store marketing expert. Analyze this screenshot of a Shopify merchant app and create a marketing plan for 1 promotional image. The image MUST be based on and visually consistent with the uploaded screenshot, preserving its colors, branding, and design context.

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
    { "headline": "...", "subhead": "...", "imagePrompt": "detailed text-to-image prompt for a Shopify App Store hero promo image, 16:9 aspect ratio, device mockup of ${ctx.appName} based on the uploaded screenshot with the headline overlay, palette ${paletteLine}, ${ctx.backgroundStyle || "clean modern"} background" }
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
  if (!parsed?.shots || parsed.shots.length < 1) throw new Error("AI did not return an image plan.");
  parsed.shots = parsed.shots.slice(0, 1);
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
    `Composition: 16:9 aspect ratio (1920x1080), professional Shopify App Store promotional screenshot. ` +
    `Stay visually consistent with the uploaded app screenshot, preserving its colors, branding, and design context. ` +
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
