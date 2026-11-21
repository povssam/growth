"""Temporally stable semantic region masks for interior footage.

Pipeline
1. UperNet-ConvNeXt (ADE20K, MIT license) per-frame class probabilities.
2. Group ADE20K classes into the regions Growth edits (wall, ceiling, floor,
   door, light, person, protect).
3. Bidirectional optical-flow-warped fusion: each frame's probabilities are
   blended with motion-compensated neighbours, which removes boundary flicker
   while still following camera movement.
4. Guided-filter upsampling snaps the low-res masks to real image edges.

The fused masks are cached to disk (``.npz``) and reused by every preview /
full render of the same clip, so segmentation is paid for once.
"""
from __future__ import annotations

import os
from typing import Callable

import cv2
import numpy as np
import torch

MODEL_ID = os.environ.get("GROWTH_SEG_MODEL", "openmmlab/upernet-convnext-large")

# ADE20K ids (verified against model.config.id2label at load time).
REGIONS: dict[str, list[str]] = {
    "wall": ["wall", "column"],
    "ceiling": ["ceiling"],
    "floor": ["floor", "rug", "stairs", "stairway", "step"],
    "door": ["door", "screen door"],
    "light": ["lamp", "light", "sconce", "chandelier"],
    "person": ["person"],
}
REGION_ORDER = ["wall", "ceiling", "floor", "door", "light", "person", "other"]

_model = None
_proc = None


def _device() -> str:
    return "cuda" if torch.cuda.is_available() else "cpu"


def load():
    global _model, _proc
    if _model is None:
        from transformers import AutoImageProcessor, UperNetForSemanticSegmentation

        _proc = AutoImageProcessor.from_pretrained(MODEL_ID)
        _model = UperNetForSemanticSegmentation.from_pretrained(MODEL_ID).eval().to(_device())
        if _device() == "cuda":
            _model = _model.half()
    return _model, _proc


def _region_index(model) -> np.ndarray:
    """Map each ADE20K class id -> region index."""
    id2label = {int(k): v for k, v in model.config.id2label.items()}
    lut = np.full(len(id2label), REGION_ORDER.index("other"), np.int64)
    for ri, region in enumerate(REGION_ORDER[:-1]):
        for cid, label in id2label.items():
            if label in REGIONS[region]:
                lut[cid] = ri
    return lut


@torch.inference_mode()
def frame_region_probs(frames: list[np.ndarray], short_side: int = 512, batch: int = 4) -> np.ndarray:
    """Return (T, R, h, w) float16 region probabilities at segmentation resolution."""
    model, proc = load()
    lut = torch.from_numpy(_region_index(model)).to(_device())
    H, W = frames[0].shape[:2]
    s = short_side / min(H, W)
    sh, sw = int(round(H * s / 32) * 32), int(round(W * s / 32) * 32)
    mean = torch.tensor(proc.image_mean, device=_device()).view(1, 3, 1, 1)
    std = torch.tensor(proc.image_std, device=_device()).view(1, 3, 1, 1)
    out = []
    dtype = next(model.parameters()).dtype
    for i in range(0, len(frames), batch):
        chunk = np.stack([cv2.resize(f, (sw, sh), interpolation=cv2.INTER_AREA) for f in frames[i:i + batch]])
        x = torch.from_numpy(chunk).to(_device()).permute(0, 3, 1, 2).float() / 255.0
        x = ((x - mean) / std).to(dtype)
        logits = model(pixel_values=x).logits.float()  # (B, 150, sh, sw)
        probs = logits.softmax(1)
        reg = torch.zeros(probs.shape[0], len(REGION_ORDER), sh, sw, device=probs.device)
        reg.index_add_(1, lut, probs)
        out.append(reg.half().cpu().numpy())
    return np.concatenate(out, 0)


def _flow(prev_gray: np.ndarray, cur_gray: np.ndarray) -> np.ndarray:
    # Flow from cur -> prev, used to pull prev's values into cur's frame.
    return cv2.calcOpticalFlowFarneback(cur_gray, prev_gray, None, 0.5, 4, 21, 3, 5, 1.1, 0)


def _warp(arr: np.ndarray, flow: np.ndarray) -> np.ndarray:
    h, w = flow.shape[:2]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    mx, my = gx + flow[..., 0], gy + flow[..., 1]
    # arr: (R, h, w) -> warp each channel
    return np.stack([cv2.remap(c, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE) for c in arr])


def temporal_fuse(probs: np.ndarray, frames: list[np.ndarray], alpha: float = 0.3) -> np.ndarray:
    """Bidirectional motion-compensated EMA over region probabilities."""
    T, R, h, w = probs.shape
    grays = [cv2.cvtColor(cv2.resize(f, (w, h), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY) for f in frames]
    p = probs.astype(np.float32)
    fwd = np.empty_like(p)
    bwd = np.empty_like(p)
    flows_b = [None] + [_flow(grays[t - 1], grays[t]) for t in range(1, T)]       # t -> t-1
    flows_f = [_flow(grays[t + 1], grays[t]) for t in range(T - 1)] + [None]      # t -> t+1
    fwd[0] = p[0]
    for t in range(1, T):
        fwd[t] = alpha * p[t] + (1 - alpha) * _warp(fwd[t - 1], flows_b[t])
    bwd[T - 1] = p[T - 1]
    for t in range(T - 2, -1, -1):
        bwd[t] = alpha * p[t] + (1 - alpha) * _warp(bwd[t + 1], flows_f[t])
    fused = 0.5 * (fwd + bwd)
    # Re-include the raw frame so very fast motion does not smear (fwd/bwd already contain it).
    fused /= np.clip(fused.sum(1, keepdims=True), 1e-6, None)
    return fused.astype(np.float16)


def guided_upsample(mask_lr: np.ndarray, guide_rgb: np.ndarray, radius: int = 8, eps: float = 1e-3) -> np.ndarray:
    """Fast guided filter: upsample a soft mask so its edges follow the image."""
    H, W = guide_rgb.shape[:2]
    m = cv2.resize(mask_lr.astype(np.float32), (W, H), interpolation=cv2.INTER_LINEAR)
    I = cv2.cvtColor(guide_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    k = (2 * radius + 1, 2 * radius + 1)
    mean_I = cv2.blur(I, k)
    mean_p = cv2.blur(m, k)
    cov_Ip = cv2.blur(I * m, k) - mean_I * mean_p
    var_I = cv2.blur(I * I, k) - mean_I * mean_I
    a = cov_Ip / (var_I + eps)
    b = mean_p - a * mean_I
    q = cv2.blur(a, k) * I + cv2.blur(b, k)
    return np.clip(q, 0.0, 1.0)


def segment_clip(frames: list[np.ndarray], cache_path: str | None = None,
                 progress: Callable[[float, str], None] | None = None,
                 should_cancel: Callable[[], bool] | None = None) -> np.ndarray:
    """Return fused (T, R, h, w) float16 probabilities; cached at ``cache_path``."""
    if cache_path and os.path.exists(cache_path):
        data = np.load(cache_path)
        if data["probs"].shape[0] == len(frames):
            return data["probs"]
    probs = []
    step = 8
    for i in range(0, len(frames), step):
        if should_cancel and should_cancel():
            raise InterruptedError("cancelled")
        probs.append(frame_region_probs(frames[i:i + step]))
        if progress:
            progress(min(1.0, (i + step) / len(frames)) * 0.85, "Understanding the space")
    probs = np.concatenate(probs, 0)
    # Fuse at a moderate resolution (cheap flow, smooth masks).
    T, R, h, w = probs.shape
    fh = 288
    fw = int(round(w * fh / h))
    small = np.stack([np.stack([cv2.resize(c.astype(np.float32), (fw, fh), interpolation=cv2.INTER_AREA) for c in p]) for p in probs])
    fused = temporal_fuse(small, frames)
    if progress:
        progress(1.0, "Tracking surfaces")
    if cache_path:
        np.savez_compressed(cache_path, probs=fused)
    return fused
