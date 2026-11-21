# Growth: AI Video Studio

Turn ordinary phone footage into cinematic spaces, from an iPhone. Growth is a mobile-first PWA
on Cloudflare, with renders on pay-per-second, scale-to-zero GPUs.

**Tool 1: Restyle Space** (working, tested on real footage). Repaints walls, doors and ceilings,
changes finish and relights the scene. The architecture, the exact floor tile or carpet pattern,
door positions and the camera move are preserved by construction, because no generative model
redraws the frame. See [docs/RESEARCH.md](docs/RESEARCH.md) for why and for the benchmark numbers.

```
web/     Next.js 15 + Tailwind 4 PWA (static export): Upload → Look → Customize → Preview → Full → Save
api/     Cloudflare Worker: serves the PWA, R2 uploads/media, Durable Object (SQLite) jobs, cost estimates, budget, RunPod dispatch
engine/  Python GPU worker: segmentation (cached) → restyle → H.264/AAC; RunPod handler + Dockerfile
docs/    RESEARCH.md (verified models/licenses/pricing), COSTS.md (costs, limits, roadmap), DEPLOY.md
```

## Try the engine locally (CPU works, just slower)

```bash
cd engine && pip install torch transformers opencv-python-headless requests
python -m growth_engine.cli hallway.mp4 out.mp4 --preset luxury-interior --mode preview
python -m growth_engine.benchmark hallway.mp4 out.mp4 /tmp/growth-cache/seg-*.npz
```

Presets: `luxury-interior`, `minimal-architecture`, `clean-studio`, `cinematic-night`, `golden-hour`,
`cyberpunk`, `as-shot` ([engine/growth_engine/presets.json](engine/growth_engine/presets.json), shared with the UI).

## Full stack locally

```bash
cd engine && python dev_server.py --port 8789          # RunPod-compatible API running the real engine
cd api && cp .dev.vars.example .dev.vars && npx wrangler dev       # http://127.0.0.1:8787
cd web && npm run build                                  # the Worker serves web/out
```

Deploying: [docs/DEPLOY.md](docs/DEPLOY.md).
