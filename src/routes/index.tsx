import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import JSZip from "jszip";
import { generatePromos } from "@/lib/generate.functions";
import { useTheme } from "@/hooks/use-theme";
import { PaymentDialog } from "@/components/PaymentDialog";
import { Footer } from "@/components/Footer";
import { extractFromDataUrl } from "@/lib/extract-palette";


type FormData = {
  email: string;
  appName: string;
  targetAudience: string;
  objective: string;
};

export const Route = createFileRoute("/")({
  component: Index,
});

type Result = Awaited<ReturnType<typeof generatePromos>>;

const MAX_BYTES = 8 * 1024 * 1024;
const PRICE_DISPLAY = "$0.50";

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Downscale + recompress so the base64 payload stays small enough for the
// server-fn RPC body (preview proxy fails on multi-MB JSON bodies).
async function compressImage(dataUrl: string, maxDim = 1280, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(dataUrl);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("Failed to load image for compression"));
    img.src = dataUrl;
  });
}

async function downloadAsZip(shots: Result["shots"]) {
  const zip = new JSZip();
  const folder = zip.folder("screenmint-promos")!;
  await Promise.all(
    shots.map(async (shot, i) => {
      if (!shot.image) return;
      try {
        const res = await fetch(shot.image);
        const blob = await res.blob();
        folder.file(`shot-${String(i + 1).padStart(2, "0")}.png`, blob);
      } catch {
        /* skip failed images */
      }
    }),
  );
  const content = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(content);
  const a = document.createElement("a");
  a.href = url;
  a.download = "screenmint-promos.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Index() {
  const generate = useServerFn(generatePromos);
  const { theme } = useTheme();
  const [preview, setPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "preview" | "loading" | "done">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [form, setForm] = useState<FormData>({ email: "", appName: "", targetAudience: "", objective: "" });
  const [paid, setPaid] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image (PNG, JPG, or WebP).");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("Image too large. Keep it under 8MB.");
      return;
    }
    const dataUrl = await readAsDataURL(file);
    const compressed = await compressImage(dataUrl).catch(() => dataUrl);
    setPreview(compressed);
    setResult(null);
    setPaid(false);
    setStatus("preview");
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!preview) return;
    if (!form.email.trim() || !form.appName.trim() || !form.targetAudience.trim() || !form.objective.trim()) {
      toast.error("Please fill in all fields.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      toast.error("Please enter a valid email address.");
      return;
    }
    setStatus("loading");
    try {
      const { palette, backgroundStyle } = await extractFromDataUrl(preview, 5);
      const res = await generate({
        data: {
          imageDataUrl: preview,
          email: form.email.trim(),
          appName: form.appName.trim(),
          targetAudience: form.targetAudience.trim(),
          objective: form.objective.trim(),
          palette,
          backgroundStyle,
        },
      });
      setResult(res);
      setPaid(false);
      setStatus("done");
      toast.success("3 promo shots ready — preview below.");
    } catch (e) {
      setStatus("preview");
      toast.error(e instanceof Error ? e.message : "Generation failed");
    }
  }, [generate, preview, form]);

  const onReset = useCallback(() => {
    setPreview(null);
    setResult(null);
    setPaid(false);
    setStatus("idle");
  }, []);

  const handleDownload = useCallback(async () => {
    if (!result || !paid) return;
    setDownloading(true);
    try {
      await downloadAsZip(result.shots);
      toast.success("ZIP downloaded!");
    } catch {
      toast.error("Download failed. Please try again.");
    } finally {
      setDownloading(false);
    }
  }, [result, paid]);

  return (
    <main className="min-h-screen bg-background text-foreground grain">
      <Toaster theme={theme} position="top-center" />
      <Nav />
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-24">
        {status === "idle" && !preview && <Hero onPick={() => fileRef.current?.click()} onDrop={handleUpload} />}
        {status === "preview" && preview && (
          <Preview image={preview} form={form} setForm={setForm} onGenerate={handleGenerate} onReset={onReset} />
        )}
        {status === "loading" && <Loading preview={preview} />}
        {status === "done" && result && (
          <Results
            result={result}
            preview={preview}
            paid={paid}
            onPaid={() => setPaid(true)}
            onDownload={handleDownload}
            downloading={downloading}
            onReset={onReset}
            email={form.email}
          />
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
            e.target.value = "";
          }}
        />
      </section>
      <FAQ />
      <Footer />
    </main>
  );
}

function Nav() {
  const { theme, toggle } = useTheme();
  return (
    <header className="mx-auto max-w-6xl px-6 pt-8 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <img
          src="/screenmint-icon.png"
          alt="Screenify icon"
          className="h-14 w-14 rounded-2xl object-cover"
        />
        <span className="font-display text-2xl tracking-tight">
          Screen<span className="text-[#3ECFB2]">ify</span>
        </span>
      </div>
      <div className="flex items-center gap-3 text-sm text-muted-foreground font-mono">
        <span className="hidden sm:inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-lime animate-pulse" /> AI live
        </span>
        <button
          onClick={toggle}
          className="inline-flex items-center justify-center rounded-full border border-border px-3 py-2 hover:bg-card transition"
          aria-label="Toggle theme"
          title="Toggle theme"
        >
          {theme === "dark" ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}

function Hero({ onPick, onDrop }: { onPick: () => void; onDrop: (f: File) => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="rise">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
        For Shopify app developers
      </p>
      <h1 className="mt-4 font-display text-5xl sm:text-7xl md:text-8xl leading-[0.95] tracking-tight text-balance">
        One screenshot.
        <br />
        <span className="italic text-lime">Three</span> store-ready promos.
      </h1>
      <p className="mt-6 max-w-xl text-lg text-muted-foreground text-balance">
        Drop a single screenshot of your Shopify app. Get 3 polished App Store images with marketing
        captions in under a minute. No designer, no Figma, no settings.
      </p>

      <div
        onClick={onPick}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onDrop(f);
        }}
        className={`mt-12 relative overflow-hidden rounded-2xl border-2 border-dashed transition cursor-pointer ${
          dragging ? "border-lime bg-lime/5 lime-glow" : "border-border bg-card/40 hover:bg-card/70"
        }`}
      >
        <div className="px-8 py-16 sm:py-20 text-center">
          <div className="mx-auto mb-6 size-14 rounded-full bg-lime grid place-items-center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-ink">
              <path d="M12 5v14M5 12l7-7 7 7" />
            </svg>
          </div>
          <p className="font-display text-3xl mb-2">Drop your app screenshot</p>
          <p className="text-muted-foreground mb-6 text-sm">PNG, JPG, or WebP · up to 8MB</p>
          <button
            onClick={(e) => { e.stopPropagation(); onPick(); }}
            className="inline-flex items-center gap-2 rounded-full bg-lime text-ink font-semibold px-6 py-3 hover:opacity-90 transition lime-glow"
          >
            Choose screenshot
            <span className="font-mono text-xs opacity-70">↵</span>
          </button>
        </div>
      </div>

      <div className="mt-16 grid sm:grid-cols-3 gap-px bg-border rounded-2xl overflow-hidden border border-border">
        {[
          { n: "01", t: "Upload", d: "One screenshot. That's the entire input." },
          { n: "02", t: "Analyze", d: "AI reads layout, purpose, and key UI." },
          { n: "03", t: "Generate", d: `3 promo images + captions · Pay ${PRICE_DISPLAY} to download.` },
        ].map((s) => (
          <div key={s.n} className="bg-card p-7">
            <div className="font-mono text-xs text-lime mb-3">{s.n}</div>
            <div className="font-display text-2xl mb-1">{s.t}</div>
            <div className="text-sm text-muted-foreground">{s.d}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Preview({
  image,
  form,
  setForm,
  onGenerate,
  onReset,
}: {
  image: string;
  form: FormData;
  setForm: React.Dispatch<React.SetStateAction<FormData>>;
  onGenerate: () => void;
  onReset: () => void;
}) {
  const update = (k: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const inputCls =
    "w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-lime/50 focus:border-lime transition";
  const labelCls = "block font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5";

  return (
    <div className="rise grid md:grid-cols-2 gap-10 items-start min-h-[60vh]">
      <div className="relative rounded-2xl overflow-hidden border border-border bg-card md:sticky md:top-8">
        <img src={image} alt="Your upload" className="w-full h-auto block" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink/80 via-transparent to-transparent" />
        <div className="absolute bottom-4 left-4 right-4 font-mono text-xs text-cream/80">your_upload.png</div>
      </div>
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-lime mb-4">Tell us about your app</p>
        <h2 className="font-display text-4xl sm:text-5xl mb-3">A few details.</h2>
        <p className="text-muted-foreground mb-6 text-sm">
          These help the AI generate promos that actually match your app instead of generic ones.
        </p>

        <div className="space-y-4 mb-6">
          <div>
            <label className={labelCls}>Email address *</label>
            <input
              type="email"
              required
              value={form.email}
              onChange={update("email")}
              placeholder="you@company.com"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>App name *</label>
            <input
              type="text"
              required
              value={form.appName}
              onChange={update("appName")}
              placeholder="e.g. ReviewBoost"
              maxLength={100}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Target audience *</label>
            <input
              type="text"
              required
              value={form.targetAudience}
              onChange={update("targetAudience")}
              placeholder="e.g. fashion DTC merchants on Shopify Plus"
              maxLength={300}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Main objective / outcome *</label>
            <textarea
              required
              value={form.objective}
              onChange={update("objective")}
              placeholder="e.g. increase product page conversion with social proof"
              maxLength={500}
              rows={3}
              className={inputCls}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={onGenerate}
            className="inline-flex items-center gap-2 rounded-full bg-lime text-ink font-semibold px-8 py-3.5 text-base hover:opacity-90 transition lime-glow"
          >
            Generate 3 promos
            <span className="font-mono text-xs opacity-70">↵</span>
          </button>
          <button
            onClick={onReset}
            className="rounded-full border border-border px-6 py-3.5 text-sm hover:bg-card transition"
          >
            Change screenshot
          </button>
        </div>
        <p className="mt-6 text-xs font-mono text-muted-foreground">Typically 30–60 seconds.</p>
      </div>
    </div>
  );
}

function Loading({ preview }: { preview: string | null }) {
  const steps = [
    "Reading your screenshot",
    "Identifying app purpose",
    "Planning 3 promo concepts",
    "Rendering store-ready images",
  ];
  return (
    <div className="rise grid md:grid-cols-2 gap-10 items-center min-h-[60vh]">
      <div className="relative rounded-2xl overflow-hidden border border-border bg-card">
        {preview && <img src={preview} alt="Your upload" className="w-full h-auto block" />}
        <div className="absolute inset-0 bg-gradient-to-t from-ink/80 via-transparent to-transparent" />
        <div className="absolute bottom-4 left-4 right-4 font-mono text-xs text-cream/80">your_upload.png</div>
      </div>
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-lime mb-4">Generating</p>
        <h2 className="font-display text-4xl sm:text-5xl mb-8">Building your promo set…</h2>
        <ul className="space-y-3">
          {steps.map((s, i) => (
            <li key={s} className="flex items-center gap-3 text-muted-foreground">
              <span
                className="size-2 rounded-full bg-lime animate-pulse"
                style={{ animationDelay: `${i * 200}ms` }}
              />
              <span>{s}</span>
            </li>
          ))}
        </ul>
        <p className="mt-8 text-xs font-mono text-muted-foreground">
          Typically 30–60 seconds. Hang tight.
        </p>
      </div>
    </div>
  );
}

function Results({
  result,
  preview,
  paid,
  onPaid,
  onDownload,
  downloading,
  onReset,
  email,
}: {
  result: Result;
  preview: string | null;
  paid: boolean;
  onPaid: () => void;
  onDownload: () => void;
  downloading: boolean;
  onReset: () => void;
  email: string;
}) {
  const [payOpen, setPayOpen] = useState(false);

  return (
    <div className="rise">
      <div className="flex flex-wrap items-end justify-between gap-6 mb-10">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-lime">
            {result.category} · {result.appName}
          </p>
          <h2 className="mt-2 font-display text-5xl sm:text-6xl leading-tight max-w-2xl text-balance">
            {result.primaryBenefit}
          </h2>
        </div>
        <button
          onClick={onReset}
          className="rounded-full border border-border px-5 py-2.5 text-sm hover:bg-card transition"
        >
          ← New screenshot
        </button>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {result.shots.map((shot, i) => (
          <ShotCard key={i} index={i} shot={shot} paid={paid} />
        ))}
      </div>

      {/* Payment / Download CTA */}
      <div className="mt-10 rounded-2xl border border-border bg-card p-8 flex flex-col sm:flex-row items-center justify-between gap-6">
        <div>
          {paid ? (
            <>
              <p className="font-mono text-xs uppercase tracking-widest text-lime mb-1">Unlocked</p>
              <p className="font-display text-2xl">Your promos are ready.</p>
              <p className="text-sm text-muted-foreground mt-1">
                Download all 3 images as a ZIP archive at full resolution.
              </p>
            </>
          ) : (
            <>
              <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-1">Preview only</p>
              <p className="font-display text-2xl">Remove watermarks · Download ZIP</p>
              <p className="text-sm text-muted-foreground mt-1">
                Pay once to download all 3 high-res images without watermarks.
              </p>
            </>
          )}
        </div>
        {paid ? (
          <button
            onClick={onDownload}
            disabled={downloading}
            className="shrink-0 inline-flex items-center gap-2 rounded-full bg-lime text-ink font-semibold px-8 py-3.5 text-base hover:opacity-90 transition lime-glow disabled:opacity-60"
          >
            {downloading ? (
              "Preparing ZIP…"
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
                Download ZIP
              </>
            )}
          </button>
        ) : (
          <button
            onClick={() => setPayOpen(true)}
            className="shrink-0 inline-flex items-center gap-2 rounded-full bg-lime text-ink font-semibold px-8 py-3.5 text-base hover:opacity-90 transition lime-glow"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Pay {PRICE_DISPLAY} · Unlock All
          </button>
        )}
      </div>

      {preview && (
        <div className="mt-16 border-t border-border pt-8">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground mb-4">
            Source screenshot
          </p>
          <img
            src={preview}
            alt="Source"
            className="max-w-xs rounded-lg border border-border opacity-70"
          />
        </div>
      )}

      <PaymentDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        onSuccess={onPaid}
        email={email}
      />
    </div>
  );
}

function ShotCard({
  shot,
  index,
  paid,
}: {
  shot: Result["shots"][number];
  index: number;
  paid: boolean;
}) {
  const [fullscreen, setFullscreen] = useState(false);


  const Watermark = () =>
    !paid ? (
      <div
        className="absolute inset-0 pointer-events-none select-none overflow-hidden"
        aria-hidden
      >
        <div className="absolute inset-0 bg-gradient-to-t from-ink/30 to-transparent" />
        <div
          className="absolute inset-0 flex flex-col justify-around"
          style={{ padding: "8px 0" }}
        >
          {Array.from({ length: 6 }).map((_, row) => (
            <div
              key={row}
              className="flex justify-around items-center"
              style={{ transform: `rotate(-25deg) scaleX(1.3)` }}
            >
              {Array.from({ length: 4 }).map((_, col) => (
                <span
                  key={col}
                  className="font-mono text-[10px] font-bold tracking-widest uppercase whitespace-nowrap opacity-40 text-white"
                >
                  Screenify · Preview
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    ) : null;

  return (
    <article className="group flex flex-col rounded-2xl border border-border bg-card overflow-hidden">
      <div className="relative aspect-[4/3] bg-muted overflow-hidden">
        {shot.image ? (
          <>
            <img
              src={shot.image}
              alt={shot.headline}
              className="w-full h-full object-cover transition group-hover:scale-[1.02] select-none pointer-events-none"
              draggable={false}
            />
            <Watermark />
          </>
        ) : (
          <div className="absolute inset-0 grid place-items-center text-destructive text-sm p-4 text-center">
            {shot.error ?? "Image failed"}
          </div>
        )}
        <div className="absolute top-3 left-3 font-mono text-[10px] tracking-widest bg-ink/70 text-cream px-2 py-1 rounded">
          SHOT {String(index + 1).padStart(2, "0")}
        </div>
        {shot.image && (
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            className="absolute bottom-3 right-3 z-10 font-mono text-[10px] tracking-widest bg-ink/80 hover:bg-ink text-cream px-2.5 py-1.5 rounded flex items-center gap-1.5 transition"
            aria-label="View fullscreen"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V3h4M21 7V3h-4M3 17v4h4M21 17v4h-4"/></svg>
            FULLSCREEN
          </button>
        )}
        {paid && shot.image && (
          <div className="absolute top-3 right-3 font-mono text-[10px] tracking-widest bg-lime text-ink px-2 py-1 rounded font-bold">
            UNLOCKED
          </div>
        )}
        {!paid && shot.image && (
          <div className="absolute top-3 right-3 font-mono text-[10px] tracking-widest bg-ink/70 text-cream/70 px-2 py-1 rounded">
            PREVIEW
          </div>
        )}
      </div>

      {fullscreen && shot.image && (
        <div
          className="fixed inset-0 z-[100] bg-ink/95 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
          onClick={() => setFullscreen(false)}
        >
          <button
            type="button"
            onClick={() => setFullscreen(false)}
            className="absolute top-4 right-4 font-mono text-xs tracking-widest bg-cream/10 hover:bg-cream/20 text-cream px-3 py-2 rounded-full transition"
            aria-label="Close fullscreen"
          >
            ✕ CLOSE
          </button>
          <div
            className="relative max-w-6xl w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={shot.image}
              alt={shot.headline}
              className="w-full h-auto max-h-[85vh] object-contain rounded-lg select-none pointer-events-none mx-auto"
              draggable={false}
            />
            <Watermark />
          </div>
        </div>
      )}
      <div className="p-5 flex flex-col gap-3 flex-1">
        <h3 className="font-display text-2xl leading-tight">{shot.headline}</h3>
        <p className="text-sm text-muted-foreground">{shot.subhead}</p>
        <div className="mt-2 rounded-lg bg-background border border-border p-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-lime mb-1">Caption</p>
          <p className="text-sm">{shot.caption}</p>
        </div>
        <div className="mt-auto flex gap-2 pt-2">
          <button
            onClick={copyCaption}
            className="flex-1 rounded-full border border-border px-4 py-2.5 text-sm hover:bg-background transition font-mono text-xs"
          >
            Copy caption
          </button>
        </div>
      </div>
    </article>
  );
}

const FAQ_ITEMS = [
  {
    q: "What exactly does Screenify do?",
    a: "You upload one screenshot of your Shopify app, fill in a few details, and Screenify generates 3 ready-to-use promo images sized perfectly for the Shopify App Store (1600×1200). No design skills needed.",
  },
  {
    q: "Do I need any design experience?",
    a: "None at all. Just paste your screenshot, answer 3 quick questions about your app, and the AI handles everything — layout, copy, colors, and composition.",
  },
  {
    q: "What screenshot should I upload?",
    a: "Use your best-looking app UI screenshot — ideally from a desktop or tablet view. Make sure the key feature you want to highlight is visible. PNG or JPEG works fine.",
  },
  {
    q: "How is the $0.50 charge applied?",
    a: "You pay once per generation to unlock and download all 3 full-resolution promo images as a ZIP file. The watermarked previews are always free.",
  },
  {
    q: "Can I preview the images before paying?",
    a: "Yes. All 3 images are generated and shown to you immediately — watermarked. You only pay when you're happy with the results and want the clean versions.",
  },
  {
    q: "What format are the downloaded images?",
    a: "You get a ZIP file containing 3 PNG images at 1600×1200px — exactly the dimensions Shopify recommends for App Store screenshots.",
  },
  {
    q: "Will the images match my app's branding?",
    a: "Screenify automatically extracts your app's dominant colors from the screenshot and uses them as the palette. The AI also uses your app name, target audience, and goal to write relevant headlines and copy.",
  },
  {
    q: "What if I don't like one of the generated images?",
    a: "Each generation produces 3 different shot styles (hero, feature callouts, and social proof). If you want a fresh set, just click Generate again — results vary with each run.",
  },
  {
    q: "Is my screenshot stored or shared?",
    a: "Your screenshot is only used during the generation process. Only a short reference snippet is saved to our database for analytics — the full image is never permanently stored.",
  },
  {
    q: "Does this work for any Shopify app?",
    a: "Yes — whether you're building a reviews app, a shipping tool, a loyalty program, or anything else. Just describe your target audience and objective and the AI tailors the images accordingly.",
  },
];

function FAQ() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section id="faq" className="mx-auto max-w-3xl px-6 py-20">
      <div className="text-center mb-12">
        <p className="font-mono text-xs tracking-widest text-lime uppercase mb-3">Got questions?</p>
        <h2 className="font-display text-4xl md:text-5xl">Frequently asked</h2>
      </div>
      <div className="flex flex-col divide-y divide-border border border-border rounded-2xl overflow-hidden">
        {FAQ_ITEMS.map((item, i) => (
          <div key={i}>
            <button
              onClick={() => setOpen(open === i ? null : i)}
              className="w-full flex items-center justify-between gap-4 px-6 py-5 text-left hover:bg-muted/40 transition-colors"
            >
              <span className="font-medium text-base">{item.q}</span>
              <span
                className="flex-shrink-0 w-6 h-6 rounded-full border border-border grid place-items-center transition-transform duration-200"
                style={{ transform: open === i ? "rotate(45deg)" : "rotate(0deg)" }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </span>
            </button>
            {open === i && (
              <div className="px-6 pb-5 text-sm text-muted-foreground leading-relaxed">
                {item.a}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
