/**
 * Growth API — Cloudflare Worker.
 *
 * - Serves the PWA (static assets) and a JSON API under /api.
 * - Media lives in R2. Large iPhone uploads use R2 multipart (client sends ~25 MB parts).
 * - Jobs live in D1 and run on a pay-per-second, scale-to-zero GPU endpoint (RunPod Serverless).
 *   Every job is cost-estimated first and refused if it would exceed the monthly budget.
 * - The GPU worker never gets storage credentials: it receives short-lived HMAC-signed URLs.
 */
export interface Env {
  ASSETS: Fetcher;
  MEDIA: R2Bucket;
  DB: D1Database;
  ACCESS_TOKEN: string; // owner passcode (secret)
  SIGNING_KEY: string; // HMAC key for media/callback URLs (secret)
  RUNPOD_API_KEY?: string; // secret
  RUNPOD_ENDPOINT_ID?: string;
  GPU_BACKEND_URL?: string; // override (local dev server that speaks the RunPod API)
  PUBLIC_URL?: string; // externally reachable base URL for callbacks
  GPU_USD_PER_SEC: string; // e.g. "0.000208" (RunPod 24 GB flex tier, $0.75/h)
  MONTHLY_BUDGET_USD: string; // hard cap, e.g. "10"
  MAX_ATTEMPTS?: string;
}

type Job = {
  id: string; tool: string; mode: string; status: string; progress: number; message: string | null;
  input_key: string; output_key: string | null; poster_key: string | null; before_key: string | null; options: string;
  provider_job_id: string | null; attempts: number; estimate_usd: number; cost_usd: number | null;
  gpu_seconds: number | null; stats: string | null; error: string | null; created_at: number; updated_at: number;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, message: string) => json({ error: message }, status);
const now = () => Date.now();
const id = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

// ---------- signing ----------
async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function signedUrl(env: Env, base: string, path: string, method: string, ttlSec: number): Promise<string> {
  const exp = Math.floor(now() / 1000) + ttlSec;
  const sig = await hmac(env.SIGNING_KEY, `${method}:${path}:${exp}`);
  return `${base}${path}?exp=${exp}&sig=${sig}`;
}
async function verifySigned(env: Env, url: URL, method: string): Promise<boolean> {
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  if (!exp || exp < now() / 1000) return false;
  const expect = await hmac(env.SIGNING_KEY, `${method}:${url.pathname}:${exp}`);
  return timingSafeEqual(sig, expect);
}
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authed(req: Request, env: Env) {
  const h = req.headers.get("authorization") || "";
  return !!env.ACCESS_TOKEN && timingSafeEqual(h, `Bearer ${env.ACCESS_TOKEN}`);
}
function baseUrl(env: Env, req: Request) {
  return env.PUBLIC_URL || new URL(req.url).origin;
}

// ---------- costs ----------
const TOOLS: Record<string, { label: string }> = { restyle: { label: "Restyle Space" } };
const MODES: Record<string, { maxSeconds: number }> = { preview: { maxSeconds: 3 }, full: { maxSeconds: 30 } };
/** GPU-seconds model (24 GB class GPU); refined from measured jobs in docs/COSTS.md. */
function estimateGpuSeconds(mode: string, clipSeconds: number) {
  const secs = Math.min(MODES[mode].maxSeconds, Math.max(1, clipSeconds || MODES[mode].maxSeconds));
  const fps = 30;
  const coldStart = 45; // container start + model load (billed)
  // Per output frame: GPU segmentation (~0.05 s) + CPU repaint, measured on CPU at
  // 0.17 s/frame for 720p (preview) and scaled by pixel count for 1080p (full).
  // Conservative until GPU timings are measured — see docs/COSTS.md.
  const perFrame = mode === "full" ? 0.45 : 0.22;
  return coldStart + secs * fps * perFrame;
}
async function spentThisMonth(env: Env): Promise<number> {
  const d = new Date();
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(COALESCE(cost_usd, CASE WHEN status IN ('queued','running') THEN estimate_usd ELSE 0 END)),0) AS s FROM jobs WHERE created_at >= ?",
  ).bind(start).first<{ s: number }>();
  return row?.s || 0;
}

// ---------- GPU provider (RunPod serverless API; local dev server speaks the same API) ----------
function gpuBase(env: Env) {
  return env.GPU_BACKEND_URL || (env.RUNPOD_ENDPOINT_ID ? `https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}` : "");
}
async function gpuFetch(env: Env, path: string, body?: unknown) {
  const base = gpuBase(env);
  if (!base) throw new Error("No GPU backend configured (set RUNPOD_ENDPOINT_ID + RUNPOD_API_KEY)");
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(env.RUNPOD_API_KEY ? { authorization: `Bearer ${env.RUNPOD_API_KEY}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`GPU backend ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function dispatch(env: Env, req: Request, job: Job) {
  const base = baseUrl(env, req);
  const ttl = 3 * 3600;
  const outKey = `outputs/${job.id}/a${job.attempts + 1}.mp4`;
  const posterKey = `outputs/${job.id}/a${job.attempts + 1}.jpg`;
  const beforeKey = `outputs/${job.id}/a${job.attempts + 1}-before.mp4`;
  const input = {
    job_id: job.id,
    tool: job.tool,
    options: JSON.parse(job.options),
    input_url: await signedUrl(env, base, `/api/media/${job.input_key}`, "GET", ttl),
    output_upload_url: await signedUrl(env, base, `/api/media/${outKey}`, "PUT", ttl),
    poster_upload_url: await signedUrl(env, base, `/api/media/${posterKey}`, "PUT", ttl),
    progress_url: await signedUrl(env, base, `/api/jobs/${job.id}/progress`, "POST", ttl),
    before_upload_url: await signedUrl(env, base, `/api/media/${beforeKey}`, "PUT", ttl),
    output_key: outKey,
    poster_key: posterKey,
    before_key: beforeKey,
  };
  const webhook = await signedUrl(env, base, `/api/jobs/${job.id}/webhook`, "POST", ttl);
  const res = await gpuFetch(env, "/run", {
    input,
    webhook,
    policy: { executionTimeout: 15 * 60 * 1000, ttl: 60 * 60 * 1000 },
  });
  await env.DB.prepare("UPDATE jobs SET provider_job_id=?, attempts=attempts+1, status='queued', message=?, updated_at=? WHERE id=?")
    .bind(res.id, "Waiting for a GPU", now(), job.id).run();
}

// ---------- handlers ----------
async function createJob(req: Request, env: Env) {
  const b = (await req.json()) as { tool?: string; mode?: string; input_key?: string; clip_seconds?: number; options?: Record<string, unknown> };
  const tool = b.tool || "restyle";
  const mode = b.mode === "full" ? "full" : "preview";
  if (!TOOLS[tool]) return err(400, "Unknown tool");
  if (!b.input_key || !(await env.MEDIA.head(b.input_key))) return err(400, "Upload not found");
  const estimate = estimateGpuSeconds(mode, b.clip_seconds || 0) * Number(env.GPU_USD_PER_SEC);
  const budget = Number(env.MONTHLY_BUDGET_USD);
  const spent = await spentThisMonth(env);
  if (spent + estimate > budget)
    return err(402, `Monthly budget reached ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Raise MONTHLY_BUDGET_USD to continue.`);
  const job: Job = {
    id: id(), tool, mode, status: "queued", progress: 0, message: "Queued", input_key: b.input_key, output_key: null,
    poster_key: null, before_key: null, options: JSON.stringify({ ...(b.options || {}), mode }), provider_job_id: null, attempts: 0,
    estimate_usd: estimate, cost_usd: null, gpu_seconds: null, stats: null, error: null, created_at: now(), updated_at: now(),
  };
  await env.DB.prepare(
    "INSERT INTO jobs (id,tool,mode,status,progress,message,input_key,options,attempts,estimate_usd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(job.id, job.tool, job.mode, job.status, 0, job.message, job.input_key, job.options, 0, estimate, job.created_at, job.updated_at).run();
  try {
    await dispatch(env, req, job);
  } catch (e) {
    await env.DB.prepare("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?").bind(String(e), now(), job.id).run();
    return err(502, String(e));
  }
  return json(await publicJob(env, req, (await getJob(env, job.id))!), 201);
}

const getJob = (env: Env, jid: string) => env.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(jid).first<Job>();

async function publicJob(env: Env, req: Request, j: Job) {
  const base = baseUrl(env, req);
  return {
    id: j.id, tool: j.tool, mode: j.mode, status: j.status, progress: j.progress, message: j.message,
    options: JSON.parse(j.options), estimate_usd: j.estimate_usd, cost_usd: j.cost_usd, gpu_seconds: j.gpu_seconds,
    stats: j.stats ? JSON.parse(j.stats) : null, error: j.error, created_at: j.created_at, attempts: j.attempts,
    input_url: await signedUrl(env, base, `/api/media/${j.input_key}`, "GET", 6 * 3600),
    output_url: j.output_key ? await signedUrl(env, base, `/api/media/${j.output_key}`, "GET", 6 * 3600) : null,
    before_url: j.before_key ? await signedUrl(env, base, `/api/media/${j.before_key}`, "GET", 6 * 3600) : null,
    poster_url: j.poster_key ? await signedUrl(env, base, `/api/media/${j.poster_key}`, "GET", 6 * 3600) : null,
  };
}

async function onProgress(req: Request, env: Env, jid: string) {
  const b = (await req.json()) as { progress?: number; message?: string };
  const j = await getJob(env, jid);
  if (!j) return err(404, "no job");
  if (j.status === "cancelled") return json({ cancel: true });
  await env.DB.prepare("UPDATE jobs SET status='running', progress=?, message=?, updated_at=? WHERE id=? AND status IN ('queued','running')")
    .bind(Math.max(0, Math.min(1, b.progress ?? 0)), (b.message || "").slice(0, 120), now(), jid).run();
  return json({ cancel: false });
}

/** RunPod webhook: called once with the final job object. */
async function onWebhook(req: Request, env: Env, jid: string) {
  const b = (await req.json()) as { id: string; status: string; executionTime?: number; delayTime?: number; output?: any; error?: string };
  const j = await getJob(env, jid);
  if (!j || b.id !== j.provider_job_id) return json({ ignored: true });
  const gpuSec = (b.executionTime || 0) / 1000;
  const cost = gpuSec * Number(env.GPU_USD_PER_SEC) + (j.cost_usd || 0);
  if (b.status === "COMPLETED" && b.output?.output_key) {
    await env.DB.prepare(
      "UPDATE jobs SET status='succeeded', progress=1, message='Ready', output_key=?, poster_key=?, before_key=?, stats=?, gpu_seconds=COALESCE(gpu_seconds,0)+?, cost_usd=?, updated_at=? WHERE id=?",
    ).bind(b.output.output_key, b.output.poster_key || null, b.output.before_key || null, JSON.stringify(b.output.stats || {}), gpuSec, cost, now(), jid).run();
  } else if (j.status === "cancelled" || b.status === "CANCELLED") {
    await env.DB.prepare("UPDATE jobs SET status='cancelled', gpu_seconds=COALESCE(gpu_seconds,0)+?, cost_usd=?, updated_at=? WHERE id=?")
      .bind(gpuSec, cost, now(), jid).run();
  } else {
    const error = (b.error || b.output?.error || b.status || "failed").toString().slice(0, 500);
    await env.DB.prepare("UPDATE jobs SET gpu_seconds=COALESCE(gpu_seconds,0)+?, cost_usd=?, error=?, updated_at=? WHERE id=?")
      .bind(gpuSec, cost, error, now(), jid).run();
    const maxAttempts = Number(env.MAX_ATTEMPTS || 2);
    const fresh = (await getJob(env, jid))!;
    // Retry transient failures once (e.g. a worker that died); never retry if the budget is gone.
    if (fresh.attempts < maxAttempts && (await spentThisMonth(env)) + fresh.estimate_usd <= Number(env.MONTHLY_BUDGET_USD)) {
      try {
        await dispatch(env, req, fresh);
        await env.DB.prepare("UPDATE jobs SET message='Retrying on a fresh GPU' WHERE id=?").bind(jid).run();
        return json({ retried: true });
      } catch (e) { /* fall through */ }
    }
    await env.DB.prepare("UPDATE jobs SET status='failed', message='Failed', updated_at=? WHERE id=?").bind(now(), jid).run();
  }
  return json({ ok: true });
}

async function cancelJob(env: Env, jid: string) {
  const j = await getJob(env, jid);
  if (!j) return err(404, "no job");
  if (!["queued", "running"].includes(j.status)) return json({ status: j.status });
  await env.DB.prepare("UPDATE jobs SET status='cancelled', message='Cancelled', updated_at=? WHERE id=?").bind(now(), jid).run();
  if (j.provider_job_id) {
    try { await gpuFetch(env, `/cancel/${j.provider_job_id}`, {}); } catch { /* the engine also polls for cancellation */ }
  }
  return json({ status: "cancelled" });
}

/** Poll the provider for jobs whose webhook may have been lost (called from GET /api/jobs/:id). */
async function reconcile(env: Env, req: Request, j: Job) {
  if (!["queued", "running"].includes(j.status) || !j.provider_job_id || now() - j.updated_at < 20000) return j;
  try {
    const s = await gpuFetch(env, `/status/${j.provider_job_id}`);
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(s.status)) {
      const fake = new Request(req.url, { method: "POST", body: JSON.stringify(s) });
      await onWebhook(fake, env, j.id);
      return (await getJob(env, j.id))!;
    }
  } catch { /* ignore */ }
  return j;
}

// ---------- media ----------
async function serveMedia(req: Request, env: Env, key: string) {
  const range = req.headers.get("range");
  let obj: R2ObjectBody | R2Object | null;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const head = await env.MEDIA.head(key);
    if (!head) return err(404, "not found");
    const size = head.size;
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (m && !m[1] && m[2]) { start = size - Number(m[2]); end = size - 1; }
    end = Math.min(end, size - 1);
    obj = await env.MEDIA.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj || !("body" in obj)) return err(404, "not found");
    return new Response(obj.body, {
      status: 206,
      headers: {
        "content-type": head.httpMetadata?.contentType || "video/mp4", "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1), "cache-control": "private, max-age=3600",
      },
    });
  }
  obj = await env.MEDIA.get(key);
  if (!obj || !("body" in obj)) return err(404, "not found");
  const dl = new URL(req.url).searchParams.get("download");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream", "accept-ranges": "bytes",
      "content-length": String(obj.size), "cache-control": "private, max-age=3600",
      ...(dl ? { "content-disposition": `attachment; filename="${dl.replace(/[^\w.-]/g, "")}"` } : {}),
    },
  });
}

function contentTypeFor(key: string) {
  if (key.endsWith(".mp4")) return "video/mp4";
  if (key.endsWith(".mov")) return "video/quicktime";
  if (key.endsWith(".jpg")) return "image/jpeg";
  if (key.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

// ---------- router ----------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      // Signed routes (GPU worker / <video> tags) — no bearer token needed.
      let m = p.match(/^\/api\/media\/(.+)$/);
      if (m && (req.method === "GET" || req.method === "HEAD") && (await verifySigned(env, url, "GET")))
        return serveMedia(req, env, decodeURIComponent(m[1]));
      if (m && req.method === "PUT" && (await verifySigned(env, url, "PUT"))) {
        const key = decodeURIComponent(m[1]);
        await env.MEDIA.put(key, req.body, { httpMetadata: { contentType: contentTypeFor(key) } });
        return json({ ok: true, key });
      }
      m = p.match(/^\/api\/jobs\/(\w+)\/progress$/);
      if (m && req.method === "POST" && (await verifySigned(env, url, "POST"))) return onProgress(req, env, m[1]);
      m = p.match(/^\/api\/jobs\/(\w+)\/webhook$/);
      if (m && req.method === "POST" && (await verifySigned(env, url, "POST"))) return onWebhook(req, env, m[1]);

      if (p === "/api/health") return json({ ok: true, gpu: !!gpuBase(env) });
      if (!authed(req, env)) return err(401, "Passcode required");

      if (p === "/api/config" && req.method === "GET") {
        return json({
          gpu_backend: gpuBase(env) ? (env.GPU_BACKEND_URL ? "local" : "runpod") : null,
          gpu_usd_per_sec: Number(env.GPU_USD_PER_SEC), monthly_budget_usd: Number(env.MONTHLY_BUDGET_USD),
          spent_this_month_usd: await spentThisMonth(env),
          estimates: {
            preview: estimateGpuSeconds("preview", 3) * Number(env.GPU_USD_PER_SEC),
            full_per_10s: estimateGpuSeconds("full", 10) * Number(env.GPU_USD_PER_SEC),
          },
        });
      }
      if (p === "/api/estimate" && req.method === "POST") {
        const b = (await req.json()) as { mode: string; clip_seconds: number };
        const mode = b.mode === "full" ? "full" : "preview";
        const usd = estimateGpuSeconds(mode, b.clip_seconds) * Number(env.GPU_USD_PER_SEC);
        return json({ usd, gpu_seconds: estimateGpuSeconds(mode, b.clip_seconds), spent: await spentThisMonth(env), budget: Number(env.MONTHLY_BUDGET_USD) });
      }
      // Multipart upload (R2). Parts must be >= 5 MiB except the last.
      if (p === "/api/uploads" && req.method === "POST") {
        const b = (await req.json()) as { name?: string; type?: string };
        const ext = (b.name || "clip.mp4").split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
        const key = `uploads/${id()}.${ext}`;
        const mp = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: b.type || contentTypeFor(key) } });
        return json({ key, upload_id: mp.uploadId });
      }
      m = p.match(/^\/api\/uploads\/(.+)\/part$/);
      if (m && req.method === "PUT") {
        const key = decodeURIComponent(m[1]);
        const mp = env.MEDIA.resumeMultipartUpload(key, url.searchParams.get("upload_id")!);
        const part = await mp.uploadPart(Number(url.searchParams.get("n")), req.body!);
        return json(part);
      }
      m = p.match(/^\/api\/uploads\/(.+)\/complete$/);
      if (m && req.method === "POST") {
        const key = decodeURIComponent(m[1]);
        const b = (await req.json()) as { upload_id: string; parts: R2UploadedPart[]; name?: string; bytes?: number; duration?: number };
        await env.MEDIA.resumeMultipartUpload(key, b.upload_id).complete(b.parts);
        await env.DB.prepare("INSERT OR REPLACE INTO uploads (key,name,bytes,duration,created_at) VALUES (?,?,?,?,?)")
          .bind(key, b.name || null, b.bytes || null, b.duration || null, now()).run();
        return json({ key, url: await signedUrl(env, baseUrl(env, req), `/api/media/${key}`, "GET", 6 * 3600) });
      }
      if (p === "/api/jobs" && req.method === "POST") return createJob(req, env);
      if (p === "/api/jobs" && req.method === "GET") {
        const rows = await env.DB.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 40").all<Job>();
        return json({ jobs: await Promise.all(rows.results.map((j) => publicJob(env, req, j))) });
      }
      m = p.match(/^\/api\/jobs\/(\w+)$/);
      if (m && req.method === "GET") {
        let j = await getJob(env, m[1]);
        if (!j) return err(404, "no job");
        j = await reconcile(env, req, j);
        return json(await publicJob(env, req, j));
      }
      m = p.match(/^\/api\/jobs\/(\w+)\/cancel$/);
      if (m && req.method === "POST") return cancelJob(env, m[1]);
      return err(404, "not found");
    } catch (e) {
      return err(500, String(e));
    }
  },
} satisfies ExportedHandler<Env>;
