"""End-to-end Restyle Space job: decode -> segment (cached) -> restyle -> encode."""
from __future__ import annotations

import hashlib
import os
import time
from typing import Callable

import numpy as np

from . import presets, segment, video_io
from .restyle import RestyleParams, Restyler

MODES = {
    # Short, low-res render to judge the look before paying for a full render.
    "preview": {"max_seconds": 3.0, "max_long_side": 720, "crf": 22},
    "full": {"max_seconds": 30.0, "max_long_side": 1920, "crf": 17},
}

Progress = Callable[[float, str], None]


def _file_key(path: str) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        h.update(f.read(4 << 20))
    h.update(str(os.path.getsize(path)).encode())
    return h.hexdigest()[:16]


def run_restyle(input_path: str, output_path: str, options: dict, cache_dir: str = "/tmp/growth-cache",
                progress: Progress | None = None, should_cancel: Callable[[], bool] | None = None) -> dict:
    t0 = time.time()
    progress = progress or (lambda p, m: None)
    mode = MODES[options.get("mode", "preview")]
    aspect = options.get("aspect", "original")
    start = float(options.get("start", 0.0))
    info = video_io.probe(input_path)
    duration = min(mode["max_seconds"], max(0.1, info.duration - start))
    fps = min(info.fps, 30.0)

    # Segment at a fixed analysis resolution, independent of output size, so masks are reusable.
    vf_an, aw, ah = video_io.plan_geometry(info, aspect, 960)
    vf_out, ow, oh = video_io.plan_geometry(info, aspect, mode["max_long_side"])
    progress(0.02, "Reading footage")
    frames_an = list(video_io.read_frames(input_path, vf_an, aw, ah, fps, start, duration))
    if not frames_an:
        raise RuntimeError("Could not decode any frames from the video")

    os.makedirs(cache_dir, exist_ok=True)
    key = f"{_file_key(input_path)}-{aspect}-{start:.2f}-{len(frames_an)}-{segment.MODEL_ID.split('/')[-1]}"
    cache_path = os.path.join(cache_dir, f"seg-{key}.npz")
    cached = os.path.exists(cache_path)
    probs = segment.segment_clip(frames_an, cache_path,
                                 progress=lambda p, m: progress(0.05 + 0.55 * p, m), should_cancel=should_cancel)
    if should_cancel and should_cancel():
        raise InterruptedError("cancelled")

    params = RestyleParams.from_dict(presets.resolve(options.get("preset"), options.get("overrides")))
    idx = np.linspace(0, len(frames_an) - 1, min(8, len(frames_an))).astype(int)
    restyler = Restyler(params, [frames_an[i] for i in idx], [probs[i] for i in idx])
    del frames_an

    writer = video_io.Writer(output_path, ow, oh, fps, input_path if info.has_audio else None,
                             start, duration, crf=mode["crf"])
    # Frame-aligned original (same crop / range / size, H.264) for the before/after view.
    before_path = options.get("_before_path")
    before = video_io.Writer(before_path, ow, oh, fps, None, crf=mode["crf"] + 2) if before_path else None
    n = len(probs)
    try:
        for t, frame in enumerate(video_io.read_frames(input_path, vf_out, ow, oh, fps, start, duration)):
            if t >= n:
                break
            writer.write(restyler.apply(frame, probs[t]))
            if before:
                before.write(frame)
            if t % 6 == 0:
                progress(0.62 + 0.36 * (t + 1) / n, "Repainting & relighting")
                if should_cancel and should_cancel():
                    raise InterruptedError("cancelled")
    finally:
        writer.close()
        if before:
            before.close()
    progress(1.0, "Done")
    return {"frames": n, "width": ow, "height": oh, "fps": fps, "seconds": round(n / fps, 2),
            "segmentation_cached": cached, "elapsed": round(time.time() - t0, 1)}
