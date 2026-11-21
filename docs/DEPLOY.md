# Deploying Growth

Everything below can be done from a phone or by Claude Code. Nothing here buys anything without
your approval.

## 1. GPU image (automatic)

Every push that touches `engine/` runs `.github/workflows/engine-image.yml`, which builds and pushes
`ghcr.io/povssam/growth-engine:latest`. It includes torch, ffmpeg and the baked UperNet weights.
Make the package public in GitHub → Packages, or add GHCR credentials to RunPod.

## 2. RunPod Serverless endpoint (needs your RunPod account and API key)

Create an endpoint from the image with these settings:

| Setting | Value | Why |
|---|---|---|
| GPU | 24 GB (L4 / A5000 / 3090), $0.75/h | Cheapest tier that fits |
| Workers min / max | **0 / 1** | Scale to zero; never more than one GPU |
| Idle timeout | **5 s** | GPU stops almost immediately after a job |
| Execution timeout | 900 s | Hard stop for runaway jobs |
| FlashBoot | on | Faster cold starts |

## 3. Cloudflare (needs an API token and R2 enabled)

```bash
cd api
npx wrangler r2 bucket create growth-media
npx wrangler d1 create growth            # paste database_id into wrangler.jsonc
npx wrangler d1 migrations apply growth --remote
npx wrangler secret put ACCESS_TOKEN     # your app passcode
npx wrangler secret put SIGNING_KEY      # random 32+ chars
npx wrangler secret put RUNPOD_API_KEY
# set RUNPOD_ENDPOINT_ID (and optionally MONTHLY_BUDGET_USD) in wrangler.jsonc vars
cd ../web && npm ci && npm run build && cd ../api && npx wrangler deploy
```

R2 must be enabled once in the Cloudflare dashboard (free tier: 10 GB storage, zero egress).

## 4. Install on iPhone

Open the workers.dev URL in Safari → Share → **Add to Home Screen**. Enter your passcode once.
