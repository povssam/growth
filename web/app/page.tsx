"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PRESETS from "../lib/presets.json";
import {
  ApiError, Config, Job, cancelJob, createJob, estimate, getConfig, getJob, getToken, listJobs, readDuration, saveVideo,
  setToken, uploadVideo, usd,
} from "../lib/api";
import { Button, ColorRow, Compare, ProgressBar, Segmented, Slider } from "../components/ui";

type Surface = { color?: string | null; finish?: number };
type Lighting = Record<string, number | string | undefined>;
type Look = { preset: string; wall: Surface; door: Surface; ceiling: Surface; lighting: Lighting };
type Aspect = "original" | "9:16" | "16:9" | "1:1";
type Source = { key?: string; url: string; name: string; duration: number; width: number; height: number; upload: number; error?: string };

const presetEntries = Object.entries(PRESETS as Record<string, any>);
const lookFromPreset = (id: string): Look => {
  const p = (PRESETS as Record<string, any>)[id] || {};
  return {
    preset: id,
    wall: { color: p.wall?.color ?? null, finish: p.wall?.finish ?? 0 },
    door: { color: p.door?.color ?? null, finish: p.door?.finish ?? 0 },
    ceiling: { color: p.ceiling?.color ?? null, finish: p.ceiling?.finish ?? 0 },
    lighting: { ...(p.lighting || {}) },
  };
};

export default function Home() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [view, setView] = useState<"home" | "studio" | "job">("home");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [source, setSource] = useState<Source | null>(null);
  const [look, setLook] = useState<Look>(lookFromPreset("luxury-interior"));
  const [aspect, setAspect] = useState<Aspect>("original");
  const [job, setJob] = useState<Job | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, js] = await Promise.all([getConfig(), listJobs()]);
      setConfig(c);
      setJobs(js);
      setAuthed(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthed(false);
      else setToast(String((e as Error).message));
    }
  }, []);

  useEffect(() => {
    if (!getToken()) setAuthed(false);
    else refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  if (authed === null) return <Splash />;
  if (!authed) return <Gate onDone={() => refresh()} />;

  return (
    <main className="mx-auto min-h-dvh max-w-[520px]">
      {view === "home" && (
        <HomeView
          jobs={jobs}
          config={config}
          onPick={(s) => { setSource(s); setView("studio"); }}
          onSourceUpdate={setSource}
          onOpenJob={(j) => { setJob(j); setView("job"); }}
          onError={setToast}
        />
      )}
      {view === "studio" && source && (
        <Studio
          source={source}
          look={look}
          setLook={setLook}
          aspect={aspect}
          setAspect={setAspect}
          config={config}
          onBack={() => { setView("home"); refresh(); }}
          onJob={(j) => { setJob(j); setView("job"); }}
          onError={setToast}
        />
      )}
      {view === "job" && job && (
        <JobView
          initial={job}
          canAdjust={!!source?.key && source.key === job?.options?.input_key}
          onBack={() => { setView("home"); refresh(); }}
          onAdjust={() => setView("studio")}
          onJob={(j) => setJob(j)}
          onError={setToast}
        />
      )}
      {toast && (
        <div role="status" className="rise fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+96px)] z-50 mx-auto max-w-[480px] rounded-2xl bg-raised px-4 py-3 text-[14px] text-ivory shadow-2xl">
          {toast}
        </div>
      )}
    </main>
  );
}

function Splash() {
  return <div className="grid min-h-dvh place-items-center"><Mark size={40} /></div>;
}

function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="5" y="18" width="5" height="9" rx="2.5" fill="#787468" />
      <rect x="13.5" y="12" width="5" height="15" rx="2.5" fill="#beb8ac" />
      <rect x="22" y="5" width="5" height="22" rx="2.5" fill="#e8d6b4" />
    </svg>
  );
}

function Gate({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState(false);
  return (
    <main className="safe-top safe-bottom mx-auto flex min-h-dvh max-w-[420px] flex-col justify-center px-6">
      <div className="rise">
        <Mark size={44} />
        <h1 className="mt-6 font-display text-[34px] font-semibold tracking-tight">Growth</h1>
        <p className="mt-2 text-[15px] text-soft">Your private AI video studio. Enter your passcode to continue.</p>
        <form
          className="mt-8 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setToken(code.trim());
            const r = await fetch("/api/config", { headers: { authorization: `Bearer ${code.trim()}` } });
            setBusy(false);
            if (r.ok) onDone();
            else { setBad(true); setToken(null); }
          }}
        >
          <input
            type="password" autoComplete="current-password" value={code} onChange={(e) => { setCode(e.target.value); setBad(false); }}
            placeholder="Passcode" aria-label="Passcode"
            className="h-14 w-full rounded-2xl border border-line bg-panel px-4 text-[16px] outline-none focus:border-soft"
          />
          {bad && <p className="text-[13px] text-danger">That passcode didn’t work.</p>}
          <Button disabled={!code || busy}>{busy ? "Checking…" : "Enter studio"}</Button>
        </form>
      </div>
    </main>
  );
}

function HomeView({
  jobs, config, onPick, onSourceUpdate, onOpenJob, onError,
}: {
  jobs: Job[]; config: Config | null; onPick: (s: Source) => void; onSourceUpdate: (s: Source) => void;
  onOpenJob: (j: Job) => void; onError: (m: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const done = jobs.filter((j) => j.status === "succeeded");
  return (
    <div className="safe-top safe-bottom px-4">
      <header className="flex items-center justify-between py-2">
        <div className="flex items-center gap-2.5"><Mark /><span className="font-display text-[19px] font-semibold tracking-tight">Growth</span></div>
        {config && (
          <span className="rounded-full bg-panel px-3 py-1.5 text-[12px] text-soft tabular-nums">
            {usd(config.spent_this_month_usd)} <span className="text-mute">/ ${config.monthly_budget_usd}</span>
          </span>
        )}
      </header>

      <section className="rise mt-8">
        <h1 className="font-display text-[32px] font-semibold leading-[1.08] tracking-tight">
          Shoot anywhere.<br /><span className="text-champagne">Restyle the space.</span>
        </h1>
        <p className="mt-3 max-w-[34ch] text-[15px] leading-relaxed text-soft">
          Repaint walls, doors and ceilings and relight the room. Architecture, floor and camera move stay exactly as filmed.
        </p>
      </section>

      <button
        onClick={() => input.current?.click()}
        className="rise group mt-8 flex w-full items-center gap-4 rounded-3xl border border-line bg-panel p-5 text-left transition active:scale-[0.99]"
      >
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-ivory text-ink">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </span>
        <span>
          <span className="block text-[16px] font-semibold">New video</span>
          <span className="block text-[13px] text-mute">Record or choose from Photos</span>
        </span>
      </button>
      <input
        ref={input} type="file" accept="video/*" className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const meta = await readDuration(file);
          let s: Source = { url: meta.url, name: file.name, duration: meta.duration, width: meta.width, height: meta.height, upload: 0 };
          onPick(s);
          try {
            const res = await uploadVideo(file, meta.duration, (p) => { s = { ...s, upload: p }; onSourceUpdate(s); });
            s = { ...s, key: res.key, upload: 1 };
            onSourceUpdate(s);
          } catch (err) {
            s = { ...s, error: (err as Error).message };
            onSourceUpdate(s);
            onError(`Upload failed: ${(err as Error).message}`);
          }
        }}
      />

      {config && !config.gpu_backend && (
        <p className="mt-4 rounded-2xl border border-line px-4 py-3 text-[13px] text-soft">
          No GPU endpoint is connected yet, so renders can’t start. Add the RunPod endpoint to the server config.
        </p>
      )}

      <section className="mt-10">
        <h2 className="mb-3 text-[13px] font-medium uppercase tracking-[0.08em] text-mute">Recent renders</h2>
        {jobs.length === 0 ? (
          <p className="text-[14px] text-mute">Nothing yet. Your previews and final renders will appear here.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {jobs.map((j) => (
              <button key={j.id} onClick={() => onOpenJob(j)} className="overflow-hidden rounded-2xl bg-panel text-left transition active:scale-[0.98]">
                <div className="aspect-video bg-raised">
                  {j.poster_url ? <img src={j.poster_url} alt="" className="h-full w-full object-cover" /> : <div className={j.status === "running" || j.status === "queued" ? "shimmer h-full" : "h-full"} />}
                </div>
                <div className="px-3 py-2.5">
                  <div className="text-[13px] font-medium">{(PRESETS as any)[j.options?.preset]?.label || "Custom"}</div>
                  <div className="text-[11px] text-mute">
                    {j.mode === "full" ? "Full" : "Preview"} · {j.status === "succeeded" ? usd(j.cost_usd) : j.status}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
        {done.length > 0 && <p className="mt-3 text-[12px] text-mute">Links to renders stay valid for 6 hours; reopen to refresh.</p>}
      </section>
    </div>
  );
}

function Studio({
  source, look, setLook, aspect, setAspect, config, onBack, onJob, onError,
}: {
  source: Source; look: Look; setLook: (l: Look) => void; aspect: Aspect; setAspect: (a: Aspect) => void;
  config: Config | null; onBack: () => void; onJob: (j: Job) => void; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"look" | "surfaces" | "light" | "format">("look");
  const [est, setEst] = useState<{ preview: number; full: number } | null>(null);

  useEffect(() => {
    if (!source.duration) return;
    Promise.all([estimate("preview", source.duration), estimate("full", source.duration)])
      .then(([p, f]) => setEst({ preview: p.usd, full: f.usd }))
      .catch(() => {});
  }, [source.duration]);

  const options = useMemo(() => ({
    preset: look.preset,
    aspect,
    input_key: source.key,
    overrides: { wall: look.wall, door: look.door, ceiling: look.ceiling, lighting: look.lighting },
  }), [look, aspect, source.key]);

  const go = async (mode: "preview" | "full") => {
    if (!source.key) return;
    setBusy(true);
    try {
      onJob(await createJob({ tool: "restyle", mode, input_key: source.key, clip_seconds: source.duration, options }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const L = look.lighting;
  const setL = (k: string, v: number) => setLook({ ...look, lighting: { ...L, [k]: v } });
  const setS = (k: "wall" | "door" | "ceiling", s: Partial<Surface>) => setLook({ ...look, [k]: { ...look[k], ...s } });
  const uploading = !source.key && !source.error;

  return (
    <div className="pb-40">
      <div className="safe-top sticky top-0 z-20 bg-ink/85 px-4 pb-3 backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <button onClick={onBack} className="-ml-2 flex h-11 items-center gap-1 px-2 text-[15px] text-soft" aria-label="Back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 18-6-6 6-6" /></svg>
            Studio
          </button>
          <span className="rounded-full bg-panel px-3 py-1.5 text-[12px] text-soft">Restyle Space</span>
        </div>
        <div className="mt-2 overflow-hidden rounded-2xl bg-panel" style={{ aspectRatio: aspect === "original" ? (source.width && source.height ? source.width / source.height : 16 / 9) : aspect === "9:16" ? 9 / 16 : aspect === "1:1" ? 1 : 16 / 9, maxHeight: "42dvh", marginInline: "auto" }}>
          <video src={source.url} className="h-full w-full object-cover" playsInline muted loop autoPlay />
        </div>
        {uploading && <div className="mt-3"><ProgressBar value={source.upload} label="Uploading original" /></div>}
        {source.error && <p className="mt-2 text-[13px] text-danger">Upload failed. Go back and try again.</p>}
      </div>

      <div className="px-4">
        <div className="mt-2"><Segmented value={tab} onChange={setTab} options={[{ value: "look", label: "Look" }, { value: "surfaces", label: "Surfaces" }, { value: "light", label: "Light" }, { value: "format", label: "Format" }]} /></div>

        {tab === "look" && (
          <div className="rise mt-5 grid grid-cols-2 gap-3">
            {presetEntries.map(([id, p]) => (
              <button
                key={id}
                onClick={() => setLook(lookFromPreset(id))}
                className={`rounded-2xl border p-3 text-left transition duration-200 active:scale-[0.98] ${look.preset === id ? "border-champagne bg-raised" : "border-line bg-panel"}`}
              >
                <div className="flex gap-1.5">
                  {[p.wall?.color, p.door?.color, p.ceiling?.color].map((c: string | undefined, i: number) => (
                    <span key={i} className="h-6 w-6 rounded-full border border-white/10" style={{ background: c || "linear-gradient(135deg,#6b5a45,#2a2622)" }} />
                  ))}
                </div>
                <div className="mt-3 text-[14px] font-medium">{p.label}</div>
              </button>
            ))}
          </div>
        )}

        {tab === "surfaces" && (
          <div className="rise mt-5 space-y-6">
            <ColorRow label="Walls" value={look.wall.color} onChange={(c) => setS("wall", { color: c })} />
            <ColorRow label="Doors" value={look.door.color} onChange={(c) => setS("door", { color: c })} />
            <ColorRow label="Ceiling" value={look.ceiling.color} onChange={(c) => setS("ceiling", { color: c })} />
            <Slider label="Finish — textured ↔ smooth" min={0} max={1} value={Number(look.wall.finish || 0)}
              onChange={(v) => setLook({ ...look, wall: { ...look.wall, finish: v }, door: { ...look.door, finish: v * 0.8 }, ceiling: { ...look.ceiling, finish: v * 0.8 } })}
              format={(v) => `${Math.round(v * 100)}%`} />
            <p className="text-[12px] leading-relaxed text-mute">Floors, light fixtures and people are always protected. Tile and carpet patterns stay pixel-exact.</p>
          </div>
        )}

        {tab === "light" && (
          <div className="rise mt-5 space-y-3">
            <Slider label="Warmth" value={Number(L.temperature || 0)} onChange={(v) => setL("temperature", v)} />
            <Slider label="Exposure" min={-1} max={1} value={Number(L.exposure || 0)} onChange={(v) => setL("exposure", v)} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} ev`} />
            <Slider label="Contrast" value={Number(L.contrast || 0)} onChange={(v) => setL("contrast", v)} />
            <Slider label="Lamp glow" min={0} max={1} value={Number(L.practical_glow || 0)} onChange={(v) => setL("practical_glow", v)} format={(v) => `${Math.round(v * 100)}%`} />
            <Slider label="Saturation" value={Number(L.saturation || 0)} onChange={(v) => setL("saturation", v)} />
            <Slider label="Vignette" min={0} max={1} value={Number(L.vignette || 0)} onChange={(v) => setL("vignette", v)} format={(v) => `${Math.round(v * 100)}%`} />
          </div>
        )}

        {tab === "format" && (
          <div className="rise mt-5 space-y-3">
            <Segmented<Aspect> value={aspect} onChange={setAspect} options={[{ value: "original", label: "Original" }, { value: "9:16", label: "9:16" }, { value: "16:9", label: "16:9" }, { value: "1:1", label: "1:1" }]} />
            <p className="text-[12px] text-mute">Centre-cropped. Previews render 3 s at 720p; full renders up to 30 s at 1080p.</p>
          </div>
        )}
      </div>

      <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-ink/90 px-4 pt-3 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[488px] gap-2">
          <Button variant="ghost" className="w-[40%]" disabled={!source.key || busy || !config?.gpu_backend} onClick={() => go("full")}>
            <span className="flex flex-col leading-tight"><span>Full</span><span className="text-[11px] font-normal text-mute">{est ? `≈ ${usd(est.full)}` : "…"}</span></span>
          </Button>
          <Button disabled={!source.key || busy || !config?.gpu_backend} onClick={() => go("preview")}>
            <span className="flex flex-col leading-tight"><span>{busy ? "Starting…" : "Preview 3 s"}</span><span className="text-[11px] font-normal opacity-60">{est ? `≈ ${usd(est.preview)}` : uploading ? "after upload" : "…"}</span></span>
          </Button>
        </div>
      </div>
    </div>
  );
}

function JobView({
  initial, canAdjust, onBack, onAdjust, onJob, onError,
}: { initial: Job; canAdjust: boolean; onBack: () => void; onAdjust: () => void; onJob: (j: Job) => void; onError: (m: string) => void }) {
  const [job, setJob] = useState(initial);
  const [saving, setSaving] = useState(false);
  const active = job.status === "queued" || job.status === "running";

  useEffect(() => setJob(initial), [initial]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      try { setJob(await getJob(job.id)); } catch { /* keep polling */ }
    }, 1500);
    return () => clearInterval(t);
  }, [active, job.id]);

  const full = async () => {
    try {
      onJob(await createJob({ tool: job.tool, mode: "full", input_key: job.options.input_key, clip_seconds: 30, options: job.options }));
    } catch (e) { onError((e as Error).message); }
  };

  return (
    <div className="safe-top safe-bottom px-4">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="-ml-2 flex h-11 items-center gap-1 px-2 text-[15px] text-soft">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 18-6-6 6-6" /></svg>
          Studio
        </button>
        <span className="rounded-full bg-panel px-3 py-1.5 text-[12px] text-soft">{job.mode === "full" ? "Full render" : "Preview"} · {(PRESETS as any)[job.options?.preset]?.label || "Custom"}</span>
      </div>

      {active && (
        <div className="rise mt-6 space-y-6">
          <div className="relative overflow-hidden rounded-2xl bg-panel">
            <video src={job.input_url} className="aspect-video w-full object-cover opacity-50" playsInline muted loop autoPlay />
            <div className="shimmer absolute inset-0" />
          </div>
          <ProgressBar value={job.progress} label={job.message || "Starting"} />
          <div className="flex justify-between text-[12px] text-mute">
            <span>Estimated cost {usd(job.estimate_usd)}</span>
            <span>GPU shuts down automatically when done</span>
          </div>
          <Button variant="danger" onClick={async () => { await cancelJob(job.id); setJob(await getJob(job.id)); }}>Cancel render</Button>
        </div>
      )}

      {job.status === "succeeded" && job.output_url && (
        <div className="rise mt-4 space-y-4">
          <Compare before={job.before_url || job.input_url} after={job.output_url} poster={job.poster_url} />
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Length" value={`${job.stats?.seconds ?? "—"} s`} />
            <Stat label="Size" value={job.stats ? `${job.stats.width}×${job.stats.height}` : "—"} />
            <Stat label="Cost" value={usd(job.cost_usd)} />
          </div>
          <Button onClick={async () => {
            setSaving(true);
            try { await saveVideo(job.output_url!, `growth-${job.id}.mp4`); } catch (e) { if ((e as Error).name !== "AbortError") onError((e as Error).message); }
            setSaving(false);
          }}>
            {saving ? "Preparing…" : "Save MP4"}
          </Button>
          {job.mode === "preview" && <Button variant="ghost" onClick={full}>Render full quality</Button>}
          {canAdjust && <Button variant="ghost" onClick={onAdjust}>Adjust look</Button>}
        </div>
      )}

      {(job.status === "failed" || job.status === "cancelled") && (
        <div className="rise mt-10 space-y-4">
          <h2 className="font-display text-[24px] font-semibold">{job.status === "cancelled" ? "Render cancelled" : "Render failed"}</h2>
          {job.error && <p className="break-words rounded-2xl bg-panel p-4 font-mono text-[12px] text-soft">{job.error}</p>}
          <p className="text-[13px] text-mute">Charged so far: {usd(job.cost_usd)}</p>
          {canAdjust && <Button variant="ghost" onClick={onAdjust}>Back to studio</Button>}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-panel py-3">
      <div className="text-[15px] font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-mute">{label}</div>
    </div>
  );
}
