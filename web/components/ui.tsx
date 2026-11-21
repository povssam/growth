"use client";
import { useEffect, useRef, useState } from "react";

export function Slider({
  label, value, onChange, min = -1, max = 1, step = 0.05, format,
}: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; format?: (v: number) => string;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="text-soft">{label}</span>
        <span className="tabular-nums text-mute">{format ? format(value) : value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2)}</span>
      </div>
      <input
        type="range" className="track" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
        aria-label={label}
      />
    </label>
  );
}

export const PAINTS = [
  "#F3F1EC", "#E6E4DF", "#D9CBB4", "#C9B8A0", "#A89A86", "#8E9A8B", "#56606A", "#3E4A57",
  "#2C2545", "#34373A", "#3A2A20", "#1C1F23",
];

export function ColorRow({
  label, value, onChange,
}: { label: string; value: string | null | undefined; onChange: (v: string | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-[13px]">
        <span className="text-soft">{label}</span>
        <span className="font-mono text-[11px] uppercase text-mute">{value || "as shot"}</span>
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        <button
          onClick={() => onChange(null)}
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-full border text-[10px] text-mute transition ${!value ? "border-ivory" : "border-line"}`}
          aria-label={`Keep original ${label}`}
        >
          orig
        </button>
        {PAINTS.map((c) => (
          <button
            key={c}
            onClick={() => onChange(c)}
            aria-label={`${label} ${c}`}
            className={`h-10 w-10 shrink-0 rounded-full border-2 transition duration-200 ${value?.toUpperCase() === c ? "scale-110 border-ivory" : "border-transparent"}`}
            style={{ background: c }}
          />
        ))}
        <button
          onClick={() => inputRef.current?.click()}
          className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line text-lg text-soft"
          aria-label={`Custom ${label} colour`}
        >
          +
          <input ref={inputRef} type="color" className="absolute inset-0 opacity-0" value={value || "#ffffff"} onChange={(e) => onChange(e.target.value.toUpperCase())} />
        </button>
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="grid rounded-xl bg-raised p-1" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-lg py-2 text-[13px] transition duration-200 ${value === o.value ? "bg-ivory text-ink" : "text-soft"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Button({
  children, onClick, variant = "primary", disabled, className = "",
}: { children: React.ReactNode; onClick?: () => void; variant?: "primary" | "ghost" | "danger"; disabled?: boolean; className?: string }) {
  const styles = {
    primary: "bg-ivory text-ink active:scale-[0.98]",
    ghost: "bg-raised text-ivory active:bg-line",
    danger: "bg-raised text-danger active:bg-line",
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold transition duration-150 disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

/** Before/after comparison: two synced videos, drag the divider. */
export function Compare({ before, after, poster }: { before: string; after: string; poster?: string | null }) {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(0.5);
  const [ratio, setRatio] = useState(16 / 9);

  useEffect(() => {
    const va = a.current!, vb = b.current!;
    let raf = 0;
    const sync = () => {
      if (Math.abs(va.currentTime - vb.currentTime) > 0.06) va.currentTime = vb.currentTime;
      raf = requestAnimationFrame(sync);
    };
    const onPlay = () => va.play().catch(() => {});
    const onPause = () => va.pause();
    vb.addEventListener("play", onPlay);
    vb.addEventListener("pause", onPause);
    raf = requestAnimationFrame(sync);
    return () => { cancelAnimationFrame(raf); vb.removeEventListener("play", onPlay); vb.removeEventListener("pause", onPause); };
  }, [before, after]);

  const move = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    setPos(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };

  return (
    <div
      ref={box}
      className="relative w-full touch-none overflow-hidden rounded-2xl bg-panel"
      style={{ aspectRatio: ratio }}
      onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); move(e.clientX); }}
      onPointerMove={(e) => e.buttons && move(e.clientX)}
    >
      {/* The result clip (after) is the timing master; the original is cropped/scaled the same way. */}
      <video ref={b} src={after} poster={poster || undefined} className="absolute inset-0 h-full w-full object-cover" playsInline muted loop autoPlay
        onLoadedMetadata={(e) => setRatio(e.currentTarget.videoWidth / e.currentTarget.videoHeight || 16 / 9)} />
      <video ref={a} src={before} className="absolute inset-0 h-full w-full object-cover" playsInline muted loop
        style={{ clipPath: `inset(0 ${(1 - pos) * 100}% 0 0)` }} />
      <div className="pointer-events-none absolute inset-y-0 w-px bg-ivory/90" style={{ left: `${pos * 100}%` }}>
        <div className="absolute top-1/2 -ml-[18px] grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-ivory text-ink shadow-lg">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 4 2 8l4 4M10 4l4 4-4 4" /></svg>
        </div>
      </div>
      <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-ink/60 px-2.5 py-1 text-[11px] text-soft backdrop-blur">Before</span>
      <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-ink/60 px-2.5 py-1 text-[11px] text-champagne backdrop-blur">After</span>
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="mb-2 flex justify-between text-[13px]">
        <span className="text-soft">{label}</span>
        <span className="tabular-nums text-mute">{Math.round(value * 100)}%</span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-raised">
        <div className="h-full rounded-full bg-champagne transition-[width] duration-700 ease-out" style={{ width: `${Math.max(3, value * 100)}%` }} />
        <div className="shimmer absolute inset-0" />
      </div>
    </div>
  );
}
