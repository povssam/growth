# Rendering costs, limits and remaining work

## What a render costs

Default GPU: RunPod Serverless 24 GB flex tier (L4 / A5000 / 3090) at **$0.75/h ≈ $0.000208/s**,
checked on runpod.io/pricing on 2026-11-21. You pay only while a worker runs. It scales to zero
after the endpoint idle timeout (set it to 5 s).

| Job | What's measured | Estimated GPU time | Estimated cost |
|---|---|---|---|
| Preview: 3 s, 720p, first look on a clip | — | ~45 s cold start + 90 frames × 0.22 s ≈ 65 s | **≈ $0.014** |
| Preview: another look on the same clip | segmentation cache hit (16 s on CPU in testing) | ~10–20 s, plus a cold start if the worker went idle | **≈ $0.003–0.013** |
| Full: 10 s, 1080p | — | ~45 s + 300 × 0.45 s ≈ 180 s | **≈ $0.04** |
| Full: 30 s, 1080p | — | ~45 s + 900 × 0.45 s ≈ 450 s | **≈ $0.09** |

**Measured so far (CPU only, 4 cores, no GPU attached in this session):**

* Segmentation, UperNet-ConvNeXt-L at 512 px: ~3–4 s/frame on CPU. 72 frames took 328–399 s.
* Repaint and relight at 720p: 0.17 s/frame (72 frames in 12 s).
* Full end-to-end preview through the API (8 s, 4K HEVC upload, 3 s preview): 638 s on CPU.
  The same clip with a second look and a cached segmentation: 16 s.

The per-frame GPU numbers above are **estimates**. The first real GPU job will replace them.
Every job stores its real `gpu_seconds` and `cost_usd` from RunPod's `executionTime`, and the app
shows both. The API's estimator (`api/src/index.ts → estimateGpuSeconds`) is deliberately
conservative.

## Spending safety

* **Monthly cap:** `MONTHLY_BUDGET_USD` (default **$10**). A job is refused if month-to-date spend
  plus its estimate would exceed the cap. Running jobs count at their estimate.
* **Preview first:** the UI's main button renders 3 s at 720p. A full render is a separate,
  explicitly priced action.
* **Scale to zero:** RunPod flex workers stop after the idle timeout. Recommended endpoint settings:
  `workersMin=0`, `workersMax=1`, `idleTimeout=5`, `executionTimeout=900`.
  RunPod also enforces an $80/h account-wide spend cap by default.
* **Cancel:** stops the engine at its next checkpoint (one 8-frame segmentation batch or 6 rendered
  frames, which is seconds on a GPU) and records the partial cost. Tested.
* **Retries:** at most one automatic retry, and never past the budget.

## Known limitations (honest list)

1. **Your hallway clip hasn't been processed yet.** It wasn't attached to this session. The
   benchmark used two Pexels hallway clips with the same constraints. Upload yours in the app, or
   add it to the session, and the same pipeline runs on it unchanged.
2. **No GPU run yet.** Every result so far ran on CPU. The Docker image and RunPod handler are built
   for GPU, but they need your RunPod key (a billing approval) for the first real run.
3. **Repaint is numpy on CPU** inside the GPU worker. Porting `restyle.py` to torch would make full
   renders several times faster and cheaper.
4. **Door detection depends on contrast.** Doors the same colour as the walls are found less
   reliably in the first frames of a clip. Temporal fusion fixes most of it. Tap-to-select doors
   (SAM 2.1 point prompts, Apache-2.0) is the planned fix.
5. **Small wall objects** (signs, switches) labelled as wall take on the new paint hue. Their shading
   and detail are kept.
6. **Paint lightness is relative.** The original paint's reflectance is assumed (mid-tone). A very
   dark or very light original wall may need the Exposure slider.
7. **Max 30 s per full render** for now (memory: frames are held at analysis resolution).
8. **Only Restyle Space is exposed in the UI.** Background replacement, cutouts, object removal and
   generative effects are researched (docs/RESEARCH.md) but not built. Per the brief, there are no
   placeholder buttons for them.

## Next features, in order

1. Torch port of the repaint and grade (speed and cost).
2. **Cutout:** BiRefNet (MIT) + SAM 2.1 tracking → green screen, white screen, transparent
   (ProRes 4444 / WebM alpha / PNG ZIP), and composite onto an uploaded reference image.
3. Tap-to-select masks (SAM 2.1) for doors and "edit only this".
4. **Generative backgrounds** from a text prompt (FLUX.3 klein plate + relit composite).
5. Object removal and replacement via Wan 2.1 VACE (Apache-2.0) on a 48–80 GB GPU through a ComfyUI
   worker.
