"""Video decode/encode through ffmpeg pipes.

Handles iPhone footage (HEVC, rotation metadata, VFR) by letting ffmpeg apply
autorotation and resample to a constant frame rate. Audio is copied from the
source into the output untouched.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from typing import Iterator

import numpy as np

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"


@dataclass
class VideoInfo:
    width: int  # display width after rotation
    height: int
    fps: float
    duration: float
    frames: int
    has_audio: bool


def probe(path: str) -> VideoInfo:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
        check=True, capture_output=True, text=True,
    ).stdout
    meta = json.loads(out)
    v = next(s for s in meta["streams"] if s["codec_type"] == "video")
    has_audio = any(s["codec_type"] == "audio" for s in meta["streams"])
    w, h = int(v["width"]), int(v["height"])
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if "rotate" in v.get("tags", {}):
        rot = int(v["tags"]["rotate"])
    if abs(rot) % 180 == 90:
        w, h = h, w
    num, den = (v.get("avg_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den) if float(den) else 30.0
    if not (1 <= fps <= 240):
        fps = 30.0
    duration = float(meta["format"].get("duration") or v.get("duration") or 0)
    return VideoInfo(w, h, fps, duration, int(round(duration * fps)), has_audio)


ASPECTS = {"original": None, "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1.0}


def plan_geometry(info: VideoInfo, aspect: str, max_long_side: int) -> tuple[str, int, int]:
    """Return an ffmpeg filter (center crop to aspect + scale) and output size."""
    target = ASPECTS.get(aspect)
    w, h = info.width, info.height
    crop = ""
    if target:
        if w / h > target:  # too wide -> crop width
            cw, ch = int(h * target) // 2 * 2, h
        else:
            cw, ch = w, int(w / target) // 2 * 2
        crop = f"crop={cw}:{ch},"
        w, h = cw, ch
    scale = min(1.0, max_long_side / max(w, h))
    ow, oh = int(w * scale) // 2 * 2, int(h * scale) // 2 * 2
    return f"{crop}scale={ow}:{oh}:flags=lanczos", ow, oh


def read_frames(path: str, vf: str, w: int, h: int, fps: float,
                start: float = 0.0, duration: float | None = None) -> Iterator[np.ndarray]:
    """Yield RGB uint8 frames (h, w, 3)."""
    cmd = [FFMPEG, "-v", "error"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", path]
    if duration:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-vf", f"{vf},fps={fps:.5f}", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(n)
            if len(buf) < n:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        proc.stdout.close()
        proc.wait()


class Writer:
    """H.264 MP4 writer (yuv420p, faststart: plays inline on iOS Safari)."""

    def __init__(self, out_path: str, w: int, h: int, fps: float, audio_src: str | None = None,
                 start: float = 0.0, duration: float | None = None, crf: int = 17):
        cmd = [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
               "-s", f"{w}x{h}", "-r", f"{fps:.5f}", "-i", "-"]
        if audio_src:
            if start:
                cmd += ["-ss", f"{start:.3f}"]
            cmd += ["-i", audio_src]
            if duration:
                cmd += ["-t", f"{duration:.3f}"]
            cmd += ["-map", "0:v", "-map", "1:a?", "-c:a", "aac", "-b:a", "192k", "-shortest"]
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p",
                "-profile:v", "high", "-movflags", "+faststart", "-tag:v", "avc1", out_path]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    def write(self, rgb: np.ndarray) -> None:
        self.proc.stdin.write(np.ascontiguousarray(rgb, dtype=np.uint8).tobytes())

    def close(self) -> None:
        self.proc.stdin.close()
        if self.proc.wait() != 0:
            raise RuntimeError("ffmpeg encode failed")


def poster(path: str, out_jpg: str, at: float = 0.0, width: int = 720) -> None:
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", f"{at:.2f}", "-i", path, "-frames:v", "1",
                    "-vf", f"scale={width}:-2", "-q:v", "3", out_jpg], check=True)
