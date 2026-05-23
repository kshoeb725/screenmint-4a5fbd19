import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// ─── API helpers ────────────────────────────────────────────────────────────

function getGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured. Add it to your environment variables.");
  return key;
}

/** Call Gemini 1.5 Flash with optional inline image for vision tasks. */
async function geminiGenerate(
  prompt: string,
  imageDataUrl?: string,
): Promise<string> {
  const key = getGeminiKey();

  const parts: unknown[] = [{ text: prompt }];
  if (imageDataUrl) {
    const [header, base64Data] = imageDataUrl.split(",");
    const mimeType = header.match(/data:([^;]+)/)?.[1] ?? "image/jpeg";
    parts.push({ inline_data: { mime_type: mimeType, data: base64Data } });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 4096,
          temperature: 0.7,
        },
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("Gemini rate limit hit. Please retry in a moment.");
    if (res.status === 403) throw new Error("Invalid GEMINI_API_KEY. Check your key at ai.google.dev.");
    throw new Error(`Gemini error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

/** Generate an image via Pollinations.ai — free, no key needed. Returns a URL. */
async function pollinationsImage(prompt: string): Promise<string> {
  const seed = Math.floor(Math.random() * 999_999);
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=1600&height=1200&nologo=true&model=flux&seed=${seed}&enhance=true`;
  // Pollinations generates on-demand at the URL — just validate it loads
  const check = await fetch(url, { method: "HEAD" });
  if (!check.ok) throw new Error(`Pollinations image generation failed (${check.status})`);
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

App details (treat as ground truth):
- App name: ${ctx.appName}
- Target audience: ${ctx.targetAudience}
- Main objective: ${ctx.objective}
- Brand colors extracted from screenshot: ${paletteLine}
- Background style: ${ctx.backgroundStyle || "clean modern"}

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "appName": "${ctx.appName}",
  "category": "one-word Shopify app category",
  "primaryBenefit": "compelling 8-12 word benefit statement",
  "shots": [
    {
      "headline": "bold 4-8 word headline for promo shot 1",
      "subhead": "10-16 word supporting line",
      "caption": "marketing caption under 90 chars mentioning ${ctx.targetAudience}",
      "imagePrompt": "detailed text-to-image prompt for a professional Shopify App Store promo image (1600x1200px, 4:3). The image should: show a clean device mockup (laptop or phone) displaying a UI dashboard for a Shopify app called '${ctx.appName}', surrounded by floating UI elements, annotation callouts, and stats relevant to '${ctx.objective}'. Use a branded background with colors ${paletteLine} in a ${ctx.backgroundStyle || 'clean modern'} style. Include large bold headline text '${ctx.appName}' at the top. Premium editorial feel, generous whitespace, professional marketing quality. NO watermarks, NO lorem ipsum."
    },
    {
      "headline": "bold 4-8 word headline for promo shot 2",
      "subhead": "10-16 word supporting line",
      "caption": "marketing caption under 90 chars",
      "imagePrompt": "detailed text-to-image prompt describing shot 2 as a feature-callout promo (1600x1200px). Show the Shopify app '${ctx.appName}' UI with annotation pills and arrows highlighting 2-3 key features relevant to '${ctx.targetAudience}'. Background uses palette ${paletteLine}. Clean SaaS product screenshot style, annotation bubbles in accent color, professional typography."
    },
    {
      "headline": "bold 4-8 word headline for promo shot 3",
      "subhead": "10-16 word supporting line",
      "caption": "marketing caption under 90 chars",
      "imagePrompt": "detailed text-to-image prompt for shot 3 as a social-proof/results promo (1600x1200px). Show the Shopify app '${ctx.appName}' alongside a large stat card (e.g. '+47% conversion') and a merchant testimonial quote badge. Background uses palette ${paletteLine}. Modern data visualization aesthetic, trust-building design, professional."
    }
  ]
}`;

  const raw = await geminiGenerate(prompt, imageDataUrl);
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
    `Composition: 1600x1200px, 4:3 aspect ratio, Shopify App Store promotional image. ` +
    `Background color: ${bg}, palette: ${paletteList}, style: ${backgroundStyle || "clean modern"}. ` +
    `Overlay headline text: "${headline}". Supporting text: "${subhead}". ` +
    `Accent color: ${accent}. Ultra high quality, professional marketing graphic, no watermarks.`;

  return pollinationsImage(fullPrompt);
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

    // Persist submission (best-effort)
    try {
      const generated = shots.filter((s) => s.image).map((s) => s.image);
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
