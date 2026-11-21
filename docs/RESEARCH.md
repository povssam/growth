# Growth: technology research and decisions

Checked on **2026-11-21** against Hugging Face model cards, official repos and pricing pages.
"Verified" means I read the model card, repo or pricing page, or ran the model myself in this repo.
Nothing here is from memory alone.

## 1. What I actually ran

| Component | Source | License (verified) | Status in Growth |
|---|---|---|---|
| **UperNet + ConvNeXt-L** (ADE20K semantic seg) | `openmmlab/upernet-convnext-large` | MIT | **In production pipeline.** Labels wall / floor / ceiling / door / lamp / sconce / person. ~3 s/frame on 4 CPU cores at 512 px; expected well under 0.1 s/frame on a 24 GB GPU (not yet measured, no GPU attached) |
| UperNet + ConvNeXt-S | `openmmlab/upernet-convnext-small` | MIT | Tested; door masks noticeably worse than -L |
| Farneback optical flow (OpenCV) | opencv | Apache-2.0 | **In pipeline.** Motion-compensated temporal mask fusion |
| ffmpeg / libx264 | system | LGPL/GPL (CLI use) | **In pipeline.** HEVC/rotation-aware decode, H.264 + AAC faststart encode |

## 2. Researched, not yet integrated (verified facts)

| Model / project | What it is | License | Notes for Growth |
|---|---|---|---|
| **SAM 2.1** (`facebook/sam2.1-hiera-*`) | Promptable image+video segmentation/tracking | Apache-2.0 | In `transformers` (`Sam2VideoModel`, mask/point/box prompts). Next step for tap-to-select objects and person tracking |
| **SAM 3 / SAM 3.1** (`facebook/sam3`, `facebook/sam3.1`) | Text-prompted ("door", "wall") video segmentation | "SAM License" (other), **gated** | Best fit for text-prompted masks. Needs you to accept the license on HF and add an HF token. 860M params |
| **BiRefNet** (`ZhengPeng7/BiRefNet`) | High-res foreground matting | MIT | Planned for green/white/alpha cutouts |
| **MatAnyone** | Video matting (temporally consistent) | No license tag on HF card; upstream is S-Lab non-commercial | Fine for personal use; re-check before any commercial use |
| **Wan 2.1 VACE 14B** (`Wan-AI/Wan2.1-VACE-14B`) | Video editing / inpainting / reference-to-video | Apache-2.0 | Planned for object removal/replacement and generative background replacement. 14B params → 48–80 GB GPU |
| **LTX-2** (`Lightricks/LTX-2`) | Audio+video generation, v2v | LTX-2 Community License (other) | Candidate for effects/stylization; read license limits first |
| **MiniMax H3** (`MiniMaxAI/MiniMax-H3`, Comfy-Org repack) | 33B audio-video model, ref2v/v2v | MiniMax H3 Community License: free below US$20M/yr revenue, must display "MiniMax H3" in commercial UIs | Powers OpenJutsu; heavy (int8 streams from RAM on 16 GB GPUs) |
| **FLUX.3 [klein]** (`black-forest-labs/flux-3-image-klein`) | Image edit/generation | other (gated) | Candidate for keyframe "look development" and text-prompted background plates |
| **OpenJutsu** (`D3voz/openjutsu`, ~2.5k★) | Next.js + ComfyUI character/object swap, H3 + SAM 3.1 | MIT (app); models separate. Face fix uses InsightFace `buffalo_l` (non-commercial) + AGPL YOLO | Reference architecture for the character-swap feature; not used for environment restyle |
| `runpod-workers/worker-comfyui` | ComfyUI as a RunPod serverless API | **AGPL-3.0** | Use as a separate service image (don't link into our code) when adding ComfyUI workflows |
| `jutsuhq/open-source-higgsfield` | List of 117 projects from Comfy's #OpenSourceHiggsfield challenge (Oct 2026) | — | Good index for future effects |

## 3. Key decision: the hallway benchmark is *not* a generative problem

The constraints were: preserve the architecture exactly, preserve the exact floor tile pattern,
keep door positions and camera movement, change only paint, finishes and lighting, and no flicker
or warping. Every current video-to-video diffusion model, including VACE and H3, *redraws* the
frame from a latent. Control signals like depth or edges keep the layout, but fine repeating
texture (tile grout, carpet pattern) is regenerated and drifts from frame to frame. That is the
artifact the brief rules out.

So the Restyle Space tool does this instead:

1. **Understand the space.** Per-frame semantic probabilities from UperNet-ConvNeXt-L, grouped into
   wall / ceiling / floor / door / light / person.
2. **Track surfaces.** Bidirectional, optical-flow-warped fusion of those probabilities. A door
   that is only partly recognized in one frame gets filled in from neighbouring frames, and the mask
   edges stop flickering. The result is cached per clip and reused for every re-render.
3. **Repaint in linear light.** Each pixel keeps its original *shading* (the light, shadows and
   texture on the surface). Only the surface's albedo changes. The new paint is lit by the scene's
   own light colour, estimated from the ceiling. All constants are computed once per clip, so there
   is no per-frame normalization and no flicker.
4. **Relight.** A fixed global grade: white balance, exposure, filmic contrast, practical-light bloom
   (only on detected fixtures), shadow toning and vignette.
5. **Protect.** Floors, light fixtures and people are hard-excluded from repainting. Finish smoothing
   uses an edge-preserving filter and only acts deep inside a region.

Every output pixel derives from the same input pixel, so geometry, tile pattern and camera
motion are preserved by construction. That is measured in §4, not assumed.

Generative models are the right tool for features that *need new content*: text-prompted
backgrounds, object removal and replacement, and style transformation. Those come next, as
separate tools behind the same job system.

## 4. Benchmark results (stand-in footage)

Your hallway clip wasn't attached to the session, so I used two free Pexels clips that stress the
same constraints:

* **A:** night hotel corridor, moving POV, wall sconces, patterned carpet, many doors (Pexels 15201563)
* **B:** apartment hallway, moving camera, **floor tiles**, cool LED light (Pexels 9658661)

`python -m growth_engine.benchmark` measures:

| Clip / look | floor_structure_corr | same metric, *no-edit control* | flicker_ratio |
|---|---|---|---|
| A / Luxury Interior | 0.934 | 0.937 | 0.86 |
| A / Cinematic Night | 0.931 | 0.937 | 1.08 |
| A / Minimal Architecture | 0.936 | 0.937 | 0.83 |
| B / Luxury Interior | 0.911 | 0.907 | 0.91 |

* `floor_structure_corr`: correlation of high-pass luminance (grout, carpet pattern) inside the floor
  mask. The **no-edit control** (same decode and encode, no restyle) scores the same, so the remaining
  gap from 1.0 is H.264 compression at preview quality, not the edit.
* `flicker_ratio`: temporal luminance variation on repainted surfaces relative to the original.
  ≈1 means the edit adds no flicker.

## 5. GPU providers (pricing checked 2026-11-21)

| Provider | Model | Price (24 GB class) | Idle cost | Fit |
|---|---|---|---|---|
| **RunPod Serverless (flex)** | Docker image → `/run` API, webhooks, cancel | L4/A5000/3090 tier **$0.75/h** (≈$0.000208/s); 4090 $1.34/h; 48 GB A6000 $1.22/h; H100 $5.89/h | **$0**: scales to zero; default idle timeout 5 s; cold start (model load) is billed; default $80/h account spend cap | **Chosen.** Bearer-token REST API works from a Cloudflare Worker; scale-to-zero; per-second billing |
| Modal | Python-defined functions | L4 $0.000222/s ($0.80/h), T4 $0.59/h, H100 $3.95/h; Starter plan includes **$30/month free compute** | $0 after a configurable keep-warm (default 60 s) | Excellent DX and free tier. Not chosen because deploys need the Modal CLI with a token pair, which is awkward from an iPhone-only workflow. Strong alternative |
| RunComfy | Hosted ComfyUI | Not evaluated in depth | — | Convenient for ComfyUI, less control over cost and storage |

## 6. Architecture

```
iPhone Safari PWA (Next.js static export, Tailwind)
   │  passcode (Bearer), chunked uploads (25 MB parts)
   ▼
Cloudflare Worker  ──── R2 (media: uploads, outputs, posters; zero egress)
   │                 └── Durable Object, SQLite (jobs, costs, budget)
   │  POST /run + webhook, signed short-lived URLs (no storage creds on GPU)
   ▼
RunPod Serverless GPU worker (Docker: torch + ffmpeg + baked model weights)
   └── growth_engine: segment (cached) → restyle → encode → upload via signed PUT
```

* Cost estimate before every job; jobs are refused when month-to-date spend plus the estimate
  exceeds `MONTHLY_BUDGET_USD`.
* Preview mode: 3 s at 720p. Full: up to 30 s at 1080p.
* Cancel: the API marks the job cancelled, calls RunPod `/cancel`, and the engine also polls for
  cancellation at each progress report.
* Retries: one automatic retry on failure (never past the budget). Lost webhooks are reconciled by
  polling `/status`.

## 7. Images

* `img/hotel-presets.jpg`: original (top left), Luxury Interior, Cinematic Night, Minimal Architecture
* `img/before-after.jpg`: tile hallway and night hotel, original rows above restyled rows, at 3 timepoints
* `img/app-1.jpg`, `img/app-2.jpg`: the PWA in iPhone 15 emulation during the end-to-end test
