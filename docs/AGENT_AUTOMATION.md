# Agent automation guide

For AI coding agents (Claude Code and similar) working on Growth, and for the person
supervising them. It says what an agent may do without asking, what is already automated, and the
exact procedure and pass/fail criteria for each recurring task.

The owner works **only from an iPhone**. Anything that needs a human must be doable in Safari,
the GitHub app, or the Cloudflare and RunPod dashboards. Never hand them a step that needs a
desktop terminal.

---

## 1. Hard rules

| # | Rule | Why |
|---|---|---|
| 1 | **No paid charges without explicit approval in the current conversation.** That covers creating a RunPod endpoint, setting `GPU_ENABLED=true`, raising `MONTHLY_BUDGET_USD`, Cloudflare paid features, and paid API calls. Approval in one context doesn't carry to the next. | Personal tool, personal money |
| 2 | **Never touch Holol or Clipademic resources.** That includes Workers named `holol-*`, `clipademic-*`, `rea-website-preview`, `openrouter-proxy`, their D1 databases, and the *Clipademic Staging* account. Growth uses only the personal account `c6ef66bc7613f7d4071eb9be54fa48a4`, the Worker `growth-studio`, the R2 bucket `growth-media`, and the Durable Object class `JobStore`. | Other production projects share the account |
| 3 | **No D1.** The account is at its 10-database limit. Jobs live in the `JobStore` SQLite Durable Object (`api/src/store.ts`). | Hard platform limit |
| 4 | **Secrets only in Cloudflare Worker secrets or GitHub Actions secrets.** Never in code, `wrangler.jsonc` vars, commit messages, logs or chat. `api/.dev.vars` is local only and git-ignored. | Security |
| 5 | **GPU stays off** (`GPU_ENABLED="false"` in `api/wrangler.jsonc`) until the owner approves RunPod. While it's off the API answers render requests with 503 and records nothing. Don't weaken that guard. | Rule 1 |
| 6 | **Don't claim AI rendering works on GPU until a GPU-backed job has succeeded** (procedure §4.6). CPU-only results must be labelled CPU-only. | Honesty |
| 7 | **Don't fake output.** No placeholder render buttons, no mocked results in the product. Tools appear in the UI only once they produce real output. | Product rule from the brief |
| 8 | **Git:** work on `claude/growth-ai-video-studio-cn6z9m` (or the branch the session assigns). Don't push to `main`, force-push, or open PRs unless asked. Never commit model identifiers. | Repo hygiene |
| 9 | **Geometry-preserving edits must stay deterministic.** Restyle Space must never route frames through a generative model. Generative features belong in separate tools. | The benchmark's core constraint |

If a step needs anything in rules 1–5, stop and ask the owner, with the exact cost or change.

---

## 2. What is already automated

| Automation | Trigger | What it does | Where |
|---|---|---|---|
| **GPU image build** | Push touching `engine/**`, or manual | Builds and pushes `ghcr.io/povssam/growth-engine:latest` and `:<sha>` (CUDA torch, ffmpeg, baked UperNet weights) | `.github/workflows/engine-image.yml` |
| **Deploy + live smoke test** | **Manual only** (Actions → *deploy* → Run workflow) | Builds the PWA, creates the R2 bucket if missing, runs `wrangler deploy`, sets `ACCESS_TOKEN` and `SIGNING_KEY` (generated once) as Worker secrets, then runs `api/scripts/smoke.mjs` against the live HTTPS URL | `.github/workflows/deploy.yml` |
| **Smoke test** | Run by the deploy workflow, or by hand | Checks app shell and PWA, 401 for missing or wrong passcode, login, R2 multipart upload, byte-exact download, HTTP Range playback, tampered-signature rejection; then either a 503 with nothing recorded (GPU off) or create → status → cancel (GPU on) | `api/scripts/smoke.mjs` |
| **Quality benchmark** | By hand | Floor-pattern preservation, edge IoU, flicker ratio for a render against its source | `engine/growth_engine/benchmark.py` |
| **Spend guard** | Every job | Pre-job cost estimate; refuses jobs past `MONTHLY_BUDGET_USD`; one retry at most; cancellation is checked between processing batches | `api/src/index.ts`, `engine/growth_engine/pipeline.py`, `segment.py` |

Deploy secrets the owner adds once (GitHub → Settings → Secrets and variables → Actions):
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GROWTH_PASSCODE`, and later `RUNPOD_API_KEY`.
See `docs/DEPLOY.md`.

---

## 3. Environment notes for cloud agent sessions

* Use the personal cloud environment **`growth`**. Its network allowlist covers Hugging Face
  (`huggingface.co`, `us.aws.cdn.hf.co`, …), PyTorch, Pexels, RunPod and the Cloudflare API.
  Add a host only on a concrete, observed block, and never wildcards.
* Model downloads: set `HF_HUB_DISABLE_XET=1` if Xet transfers are blocked.
* Local servers: export `NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost`, otherwise
  requests to local servers go through the egress proxy and fail.
* The container has **no GPU** (4 CPU cores). Segmentation takes about 3–4 s per frame on CPU. A
  3 s preview takes about 5–6 min the first time, and about 15 s once its segmentation is cached.
* Playwright's Chromium **can't decode HEVC**. iPhone `.MOV` previews look black there but play in
  Safari. Use H.264 fixtures for screenshots.
* `engine/dev_server.py` can hang if left running across session restarts. `pkill -9 -f
  dev_server.py` and start it again before testing.
* Cloudflare connector: the "Cloudflare Developer Platform" connector is deprecated and **can't
  deploy Workers**. Deploy through the GitHub *deploy* workflow, or through the official
  Cloudflare plugin if the owner enables it.

---

## 4. Procedures

Each procedure ends with explicit pass criteria. Report failures with output, never as success.

### 4.1 Change the engine (restyle, segmentation, presets)

```bash
cd engine
python -m growth_engine.cli IN.mp4 out.mp4 --preset luxury-interior --cache /tmp/growth-cache
python -m growth_engine.cli IN.mp4 control.mp4 --preset as-shot --cache /tmp/growth-cache
python -m growth_engine.benchmark IN.mp4 out.mp4     /tmp/growth-cache/seg-<key>.npz
python -m growth_engine.benchmark IN.mp4 control.mp4 /tmp/growth-cache/seg-<key>.npz
```
Use `docs/samples/hotel-original.mp4` (patterned carpet, night) and `docs/samples/apartment-original.mp4`
(floor tiles) as the fixed regression pair.

**Pass:**
- `floor_structure_corr` is within **0.01** of the as-shot control on both clips.
- `flicker_ratio` is **≤ 1.15**.
- A visual check of 3 frames shows no blown-out night key, no peach cast on cool-lit footage, and
  no smearing at door or floor edges.

Presets live in `engine/growth_engine/presets.json` (shared with the UI through `web` prebuild).

### 4.2 Full stack locally (no cloud, no cost)

```bash
cd engine && python dev_server.py --port 8789 &                  # RunPod-compatible API, real engine
cd api && cp .dev.vars.example .dev.vars && npx wrangler dev --port 8787 &
cd web && npm run build                                          # Worker serves web/out
node api/scripts/smoke.mjs http://127.0.0.1:8787 dev-passcode fixture.mp4          # GPU path
npx wrangler dev --var GPU_ENABLED:false ...  && node api/scripts/smoke.mjs ...    # GPU-off path
```
**Pass:** `All checks passed` on both paths.

### 4.3 Typecheck and build gates (before every push)

```bash
cd api && npx tsc --noEmit
cd web && npm run build
```

### 4.4 Deploy (free tier; owner must have added the secrets)

The owner taps Actions → *deploy* → Run workflow, with *Enable GPU* unchecked. An agent with the
GitHub tools may trigger the same workflow only if the owner asked for a deploy in the current
conversation.
**Pass:** the workflow is green, and the run summary shows the `https://growth-studio.<subdomain>.workers.dev`
URL with every smoke check `PASS`. Then do a mobile check in Playwright `devices['iPhone 15']`:
passcode gate, upload an H.264 clip, original playback, and the "no GPU connected" notice with the
render buttons disabled. Add the exact `workers.dev` host to the environment allowlist first if
it's blocked.

### 4.5 Connect the GPU (paid, approval required)

1. Owner approves in chat, with the estimate: about **$0.014 per preview** and about
   **$0.04 per 10 s** full render at $0.75/h.
2. Owner creates the RunPod Serverless endpoint from `ghcr.io/povssam/growth-engine:latest`:
   24 GB tier, **min 0 / max 1 workers, idle timeout 5 s**, execution timeout 900 s.
3. Owner adds the `RUNPOD_API_KEY` GitHub secret and re-runs *deploy* with *Enable GPU* checked
   and the endpoint ID filled in.

### 4.6 First GPU validation: the gate for claiming "AI rendering works"

1. From the PWA, render a **Preview** of `docs/samples/hotel-original.mp4` with *Luxury Interior*.
2. **Pass:**
   - the job reaches `succeeded`
   - `gpu_seconds` and `cost_usd` are recorded and below the estimate × 2
   - the output plays in the before/after view on iPhone
   - §4.1 benchmark criteria hold on the downloaded output
   - a second look on the same clip reports `segmentation_cached: true`
3. Cancel test: start a **Full** render and cancel within 10 s. **Pass:** status `cancelled`, and
   the job's `gpu_seconds` stays below 60.
4. Write the measured GPU timings into `docs/COSTS.md`, replacing the estimates, and adjust
   `estimateGpuSeconds` in `api/src/index.ts`.

Only after this passes may docs and replies say GPU rendering works.

### 4.7 Process the owner's own footage

The owner uploads in the app. An agent may also process a clip attached to a session using §4.1
(CPU), but say so: CPU, preview quality. The benchmark constraints are fixed: preserve the
architecture, the floor tile pattern, wall geometry, door positions and the camera move; keep the
night atmosphere; no flicker or warping.

---

## 5. Status at the time of writing (2026-11-21)

| Item | State |
|---|---|
| Restyle engine | Works on CPU, benchmarked on two real hallway clips (`docs/RESEARCH.md` §4) |
| API + PWA, full stack | Passes the smoke test locally on both GPU paths; earlier iPhone-emulated end-to-end run |
| GPU image | Builds in CI; **never run on a GPU** |
| Live deployment | **Not deployed.** Waiting on R2 enablement plus deploy credentials (`docs/DEPLOY.md`) |
| GPU rendering | **Disabled**, waiting for RunPod approval |
| Owner's hallway clip | **Not yet processed** (never attached to a session) |

Update this table whenever a row changes.
