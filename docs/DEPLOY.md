# Deploying Growth

Growth runs as **one Cloudflare Worker** (`growth-studio`): it serves the PWA and the API, stores media in
**R2** (`growth-media`) and job records in a **SQLite Durable Object** (`JobStore`). There is no D1
database, because the personal account is at its 10-database limit. Nothing in the Holol or
Clipademic projects is used or touched.

Everything here is on Cloudflare's **free tiers**: Workers Free, Durable Objects (SQLite) Free, and
R2 Free (10 GB, zero egress). GPU rendering stays **off** (`GPU_ENABLED=false`) until you connect
RunPod. Until then the API refuses render jobs with HTTP 503 and records nothing.

## Deploy from your iPhone (about 5 minutes, one time)

1. **Enable R2:** Cloudflare dashboard → *Storage & databases → R2* → enable. The free plan asks for
   a payment method on file. Usage under 10 GB is not charged.
2. **Create an API token:** Cloudflare dashboard → *My Profile → API Tokens → Create Token* → use the
   **"Edit Cloudflare Workers"** template, then add **Account › Workers R2 Storage › Edit**. Limit it
   to your personal account (`Ssamoussaoui@gmail.com's Account`).
3. **Add three GitHub secrets:** github.com/povssam/growth → *Settings → Secrets and variables →
   Actions → New repository secret*
   * `CLOUDFLARE_API_TOKEN`: the token from step 2
   * `CLOUDFLARE_ACCOUNT_ID`: `c6ef66bc7613f7d4071eb9be54fa48a4`
   * `GROWTH_PASSCODE`: the passcode you'll type into the app (use a long one)
4. **Run the deploy:** *Actions → deploy → Run workflow*. Choose branch
   `claude/growth-ai-video-studio-cn6z9m` and leave *Enable GPU* unchecked.

The workflow builds the PWA, creates the R2 bucket if needed, deploys the Worker, and stores
`ACCESS_TOKEN` and a generated `SIGNING_KEY` as Worker secrets. It then **smoke-tests the live HTTPS
URL**: app shell and PWA manifest, 401 without or with a wrong passcode, passcode login, a 10 MB
multipart upload to R2, byte-exact download, ranged playback (what iOS Safari uses), tampered-URL
rejection, and that render jobs are refused while the GPU is off. The live URL is printed in the
run summary. It will be `https://growth-studio.<your-workers-subdomain>.workers.dev`.

5. On the iPhone, open the URL in Safari → Share → **Add to Home Screen** → enter your passcode.

## Connecting the GPU later (paid, needs your approval)

1. RunPod → Serverless → New Endpoint → image `ghcr.io/povssam/growth-engine:latest` (built by the
   `engine-image` workflow). Make the GHCR package public, or add registry credentials.
   Settings: 24 GB GPU tier ($0.75/h), **workers min 0 / max 1**, **idle timeout 5 s**,
   execution timeout 900 s.
2. Add the GitHub secret `RUNPOD_API_KEY`.
3. Re-run *deploy* with **Enable GPU** checked and the endpoint ID filled in. The monthly cap
   (`MONTHLY_BUDGET_USD`, default $10) and per-job estimates apply from the first job.

## Manual deploy (with wrangler, if you prefer)

```bash
cd web && npm ci && npm run build
cd ../api && npm ci
npx wrangler r2 bucket create growth-media
npx wrangler deploy --var GPU_ENABLED:false
npx wrangler secret put ACCESS_TOKEN
openssl rand -base64 48 | npx wrangler secret put SIGNING_KEY
node scripts/smoke.mjs https://growth-studio.<subdomain>.workers.dev "<passcode>" some-video.mp4
```
