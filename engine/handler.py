"""RunPod Serverless handler for Growth.

Input (built by the Cloudflare Worker, all URLs are short-lived HMAC-signed):
  job_id, tool, options, input_url, output_upload_url, poster_upload_url, progress_url,
  output_key, poster_key
Output: {output_key, poster_key, stats}

The worker holds no storage credentials. Segmentation is cached on local disk
(and on a RunPod network volume if one is mounted at /runpod-volume), so a
preview followed by a full render of the same clip only segments the preview
range once and the rest on the full pass.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import threading
import time

import requests

from growth_engine import video_io
from growth_engine.pipeline import run_restyle

CACHE_DIR = "/runpod-volume/growth-cache" if os.path.isdir("/runpod-volume") else "/tmp/growth-cache"
TOOLS = {"restyle": run_restyle}


class Reporter:
    """Throttled progress reporting; also learns about cancellation from the API's reply."""

    def __init__(self, url: str):
        self.url, self.cancelled, self._last = url, False, 0.0
        self._lock = threading.Lock()

    def __call__(self, p: float, msg: str) -> None:
        now = time.time()
        if now - self._last < 1.5 and p < 1.0:
            return
        self._last = now
        try:
            r = requests.post(self.url, json={"progress": round(p, 4), "message": msg}, timeout=10)
            if r.ok and r.json().get("cancel"):
                self.cancelled = True
        except requests.RequestException:
            pass


def _download(url: str, dest: str) -> None:
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            shutil.copyfileobj(r.raw, f, length=4 << 20)


def _upload(url: str, path: str) -> None:
    with open(path, "rb") as f:
        r = requests.put(url, data=f, timeout=600)
    r.raise_for_status()


def handler(job: dict) -> dict:
    inp = job["input"]
    tool = TOOLS.get(inp.get("tool", "restyle"))
    if tool is None:
        return {"error": f"unknown tool {inp.get('tool')}"}
    report = Reporter(inp["progress_url"])
    work = tempfile.mkdtemp(prefix="growth-")
    try:
        report(0.01, "Fetching footage")
        src = os.path.join(work, "input")
        _download(inp["input_url"], src)
        out = os.path.join(work, "output.mp4")
        before = os.path.join(work, "before.mp4")
        opts = {**inp.get("options", {}), "_before_path": before if inp.get("before_upload_url") else None}
        stats = tool(src, out, opts, CACHE_DIR, progress=report,
                     should_cancel=lambda: report.cancelled)
        report(0.99, "Uploading result")
        poster = os.path.join(work, "poster.jpg")
        video_io.poster(out, poster, at=min(1.0, stats.get("seconds", 1) / 2))
        _upload(inp["output_upload_url"], out)
        _upload(inp["poster_upload_url"], poster)
        result = {"output_key": inp["output_key"], "poster_key": inp["poster_key"], "stats": stats}
        if inp.get("before_upload_url") and os.path.exists(before):
            _upload(inp["before_upload_url"], before)
            result["before_key"] = inp["before_key"]
        return result
    except InterruptedError:
        return {"error": "cancelled"}
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    import runpod

    runpod.serverless.start({"handler": handler})
