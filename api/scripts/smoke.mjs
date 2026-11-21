#!/usr/bin/env node
/**
 * Post-deploy smoke test for Growth.
 *   node scripts/smoke.mjs <base-url> <passcode> <video-file>
 * Checks: HTTPS app shell + PWA manifest, auth (401 without passcode), passcode login,
 * R2 multipart upload, signed-URL playback with HTTP Range (what iOS Safari uses),
 * tampered-signature rejection, and job creation behaviour:
 *   - GPU disabled  -> job creation must be refused (503) and no job recorded
 *   - GPU enabled   -> a preview job is created, progress is read, then it is cancelled
 * Exits non-zero on the first failure.
 */
import { readFileSync } from "node:fs";

const [base, pass, file] = process.argv.slice(2);
if (!base || !pass || !file) {
  console.error("usage: smoke.mjs <base-url> <passcode> <video-file>");
  process.exit(2);
}
const auth = { authorization: `Bearer ${pass}` };
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 200) }; } };

// 1. App shell + PWA
let r = await fetch(base + "/");
const html = await r.text();
ok("app shell served", r.ok && html.includes("Growth"), `${r.status}`);
const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(base);
if (!local) ok("served over HTTPS", base.startsWith("https://"));
r = await fetch(base + "/manifest.webmanifest");
ok("PWA manifest", r.ok && (await j(r)).display === "standalone");
r = await fetch(base + "/sw.js");
ok("service worker", r.ok);

// 2. Auth
r = await fetch(base + "/api/config");
ok("API rejects missing passcode", r.status === 401, `${r.status}`);
r = await fetch(base + "/api/config", { headers: { authorization: "Bearer wrong" } });
ok("API rejects wrong passcode", r.status === 401, `${r.status}`);
r = await fetch(base + "/api/config", { headers: auth });
const cfg = await j(r);
ok("passcode login", r.ok, JSON.stringify(cfg));
const gpuOn = !!cfg.gpu_backend;
console.log(`      GPU backend: ${cfg.gpu_backend || "disabled"}; budget $${cfg.monthly_budget_usd}; spent $${cfg.spent_this_month_usd}`);

// 3. Multipart upload to R2 (forced into 2 parts when the file is big enough)
const data = readFileSync(file);
r = await fetch(base + "/api/uploads", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "smoke.mp4", type: "video/mp4" }) });
const up = await j(r);
ok("create multipart upload", r.ok && up.key, up.key || JSON.stringify(up));
const PART = 5 * 1024 * 1024; // R2 minimum part size
const parts = [];
for (let i = 0, n = 1; i < data.length; i += PART, n++) {
  r = await fetch(`${base}/api/uploads/${encodeURIComponent(up.key)}/part?upload_id=${encodeURIComponent(up.upload_id)}&n=${n}`, { method: "PUT", headers: auth, body: data.subarray(i, i + PART) });
  const p = await j(r);
  if (!r.ok) { ok(`upload part ${n}`, false, JSON.stringify(p)); break; }
  parts.push({ partNumber: p.partNumber, etag: p.etag });
}
r = await fetch(`${base}/api/uploads/${encodeURIComponent(up.key)}/complete`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ upload_id: up.upload_id, parts, bytes: data.length, duration: 3 }) });
const done = await j(r);
ok(`complete upload (${parts.length} part${parts.length > 1 ? "s" : ""}, ${(data.length / 1e6).toFixed(1)} MB)`, r.ok && done.url);

// 4. Playback via signed URL
r = await fetch(done.url, { headers: { range: "bytes=0-1023" } });
ok("signed URL range request (iOS playback)", r.status === 206 && r.headers.get("content-type") === "video/mp4", `${r.status} ${r.headers.get("content-range")}`);
r = await fetch(done.url);
const body = Buffer.from(await r.arrayBuffer());
ok("full download matches upload byte-for-byte", r.ok && body.equals(data), `${body.length} bytes`);
r = await fetch(done.url.replace(/sig=[^&]+/, "sig=tampered"));
ok("tampered signature rejected", r.status === 401, `${r.status}`);

// 5. Jobs
const before = (await j(await fetch(base + "/api/jobs", { headers: auth }))).jobs?.length ?? -1;
r = await fetch(base + "/api/jobs", {
  method: "POST", headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ tool: "restyle", mode: "preview", input_key: up.key, clip_seconds: 3, options: { preset: "luxury-interior", aspect: "original", input_key: up.key } }),
});
const job = await j(r);
if (!gpuOn) {
  const after = (await j(await fetch(base + "/api/jobs", { headers: auth }))).jobs?.length ?? -1;
  ok("job creation refused while GPU is disabled", r.status === 503, `${r.status} ${job.error || ""}`);
  ok("no job recorded / nothing billed", after === before, `${before} -> ${after}`);
} else {
  ok("job created with cost estimate", r.status === 201 && job.estimate_usd > 0, `${r.status} est $${job.estimate_usd}`);
  r = await fetch(`${base}/api/jobs/${job.id}`, { headers: auth });
  ok("job status readable", r.ok, (await j(r)).status);
  r = await fetch(`${base}/api/jobs/${job.id}/cancel`, { method: "POST", headers: auth });
  ok("job cancel", r.ok && (await j(r)).status === "cancelled");
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
