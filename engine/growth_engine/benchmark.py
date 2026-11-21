"""Objective checks for a restyle render.

  python -m growth_engine.benchmark ORIGINAL RESULT SEG_CACHE.npz

* floor_structure_corr: correlation of high-pass luminance (tile edges / grout /
  carpet pattern) between original and result inside the floor mask. 1.0 = the
  pattern is identical; generative re-rendering typically scores far lower.
* edge_iou: IoU of Canny edge maps over the whole frame (geometry preserved).
* flicker_ratio: temporal luminance change of the result divided by that of the
  original, measured on repainted surfaces. ~1.0 means the edit adds no
  flicker beyond what the camera motion already causes.
"""
import sys

import cv2
import numpy as np

from . import video_io
from .segment import REGION_ORDER


def _frames(path, w, h, n):
    info = video_io.probe(path)
    vf = f"scale={w}:{h}"
    return list(video_io.read_frames(path, vf, w, h, min(info.fps, 30.0), 0, None))[:n]


def main(orig, result, cache):
    probs = np.load(cache)["probs"].astype(np.float32)
    info = video_io.probe(result)
    w, h = info.width, info.height
    n = len(probs)
    A = _frames(orig, w, h, n)
    B = _frames(result, w, h, n)
    n = min(len(A), len(B), n)
    fl, wl, corr, ious, dA, dB = REGION_ORDER.index("floor"), REGION_ORDER.index("wall"), [], [], [], []
    prevA = prevB = None
    for t in range(n):
        ya = cv2.cvtColor(A[t], cv2.COLOR_RGB2GRAY).astype(np.float32)
        yb = cv2.cvtColor(B[t], cv2.COLOR_RGB2GRAY).astype(np.float32)
        floor = cv2.resize(probs[t][fl], (w, h)) > 0.9
        walls = cv2.resize(probs[t][wl] + probs[t][REGION_ORDER.index("door")], (w, h)) > 0.9
        ha = ya - cv2.GaussianBlur(ya, (0, 0), 3)
        hb = yb - cv2.GaussianBlur(yb, (0, 0), 3)
        if floor.sum() > 1000:
            corr.append(np.corrcoef(ha[floor], hb[floor])[0, 1])
        ea, eb = cv2.Canny(A[t], 60, 140) > 0, cv2.Canny(B[t], 60, 140) > 0
        ea = cv2.dilate(ea.astype(np.uint8), None) > 0
        eb = cv2.dilate(eb.astype(np.uint8), None) > 0
        ious.append((ea & eb).sum() / max(1, (ea | eb).sum()))
        # Mean luminance of repainted surfaces over time (relative to their own mean level)
        if walls.sum() > 1000:
            dA.append(ya[walls].mean())
            dB.append(yb[walls].mean())
    dA, dB = np.array(dA), np.array(dB)
    fr = (np.abs(np.diff(dB)).mean() / max(dB.mean(), 1e-3)) / max(np.abs(np.diff(dA)).mean() / max(dA.mean(), 1e-3), 1e-6)
    res = {"frames": n, "floor_structure_corr": round(float(np.mean(corr)), 4),
           "floor_structure_corr_min": round(float(np.min(corr)), 4),
           "edge_iou": round(float(np.mean(ious)), 3), "flicker_ratio": round(float(fr), 3)}
    print(res)
    return res


if __name__ == "__main__":
    main(*sys.argv[1:4])
