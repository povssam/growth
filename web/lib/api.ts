export type Job = {
  id: string;
  tool: string;
  mode: "preview" | "full";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  message: string | null;
  options: Record<string, any>;
  estimate_usd: number;
  cost_usd: number | null;
  gpu_seconds: number | null;
  stats: Record<string, any> | null;
  error: string | null;
  created_at: number;
  input_url: string;
  output_url: string | null;
  poster_url: string | null;
  before_url: string | null;
};

export type Config = {
  gpu_backend: "runpod" | "local" | null;
  gpu_usd_per_sec: number;
  monthly_budget_usd: number;
  spent_this_month_usd: number;
  estimates: { preview: number; full_per_10s: number };
};

const TOKEN_KEY = "growth.passcode";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken() || ""}`, ...(init.headers || {}) },
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new ApiError(r.status, data.error || r.statusText);
  return data as T;
}

export const getConfig = () => api<Config>("/api/config");
export const listJobs = () => api<{ jobs: Job[] }>("/api/jobs").then((r) => r.jobs);
export const getJob = (id: string) => api<Job>(`/api/jobs/${id}`);
export const cancelJob = (id: string) => api<{ status: string }>(`/api/jobs/${id}/cancel`, { method: "POST" });
export const estimate = (mode: string, clip_seconds: number) =>
  api<{ usd: number; gpu_seconds: number; spent: number; budget: number }>("/api/estimate", {
    method: "POST",
    body: JSON.stringify({ mode, clip_seconds }),
  });
export const createJob = (body: { tool: string; mode: string; input_key: string; clip_seconds: number; options: Record<string, any> }) =>
  api<Job>("/api/jobs", { method: "POST", body: JSON.stringify(body) });

const PART = 25 * 1024 * 1024; // R2 multipart parts (>= 5 MiB), well under the Worker body limit

/** Chunked upload so 4K iPhone clips (hundreds of MB) never hit request-size limits. */
export async function uploadVideo(file: File, duration: number, onProgress: (p: number) => void, signal?: AbortSignal) {
  const { key, upload_id } = await api<{ key: string; upload_id: string }>("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ name: file.name, type: file.type || "video/mp4" }),
  });
  const parts: { partNumber: number; etag: string }[] = [];
  const total = Math.max(1, Math.ceil(file.size / PART));
  for (let i = 0; i < total; i++) {
    const chunk = file.slice(i * PART, Math.min(file.size, (i + 1) * PART));
    const part = await putWithProgress(
      `/api/uploads/${encodeURIComponent(key)}/part?upload_id=${encodeURIComponent(upload_id)}&n=${i + 1}`,
      chunk,
      (p) => onProgress((i + p) / total),
      signal,
    );
    parts.push({ partNumber: part.partNumber, etag: part.etag });
  }
  return api<{ key: string; url: string }>(`/api/uploads/${encodeURIComponent(key)}/complete`, {
    method: "POST",
    body: JSON.stringify({ upload_id, parts, name: file.name, bytes: file.size, duration }),
  });
}

function putWithProgress(url: string, body: Blob, onProgress: (p: number) => void, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("authorization", `Bearer ${getToken() || ""}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new ApiError(xhr.status, xhr.responseText)));
    xhr.onerror = () => reject(new ApiError(0, "Network error during upload"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(body);
  });
}

/** iOS: the share sheet's "Save Video" puts the MP4 straight into Photos. */
export async function saveVideo(url: string, filename: string) {
  const res = await fetch(url);
  const blob = await res.blob();
  const file = new File([blob], filename, { type: "video/mp4" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file] });
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function readDuration(file: File): Promise<{ duration: number; width: number; height: number; url: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () => resolve({ duration: v.duration || 0, width: v.videoWidth, height: v.videoHeight, url });
    v.onerror = () => resolve({ duration: 0, width: 0, height: 0, url });
    v.src = url;
  });
}

export const usd = (n: number | null | undefined) =>
  n == null ? "—" : n === 0 ? "$0.00" : n < 0.01 ? `<$0.01` : `$${n.toFixed(n < 1 ? 3 : 2)}`;
