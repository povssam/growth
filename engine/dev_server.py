"""Local stand-in for a RunPod Serverless endpoint (same /run, /status, /cancel API + webhook).

Runs the *real* handler on this machine (CPU or local GPU), one job at a time,
so the whole product can be exercised end-to-end without a cloud GPU:

    python dev_server.py --port 8789
    # api/.dev.vars: GPU_BACKEND_URL=http://127.0.0.1:8789
"""
from __future__ import annotations

import argparse
import json
import queue
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

from handler import handler

JOBS: dict[str, dict] = {}
Q: "queue.Queue[str]" = queue.Queue()


def worker() -> None:
    while True:
        jid = Q.get()
        job = JOBS[jid]
        if job["status"] == "CANCELLED":
            continue
        job["status"] = "IN_PROGRESS"
        t0 = time.time()
        try:
            out = handler({"id": jid, "input": job["input"]})
            job["output"] = out
            job["status"] = "COMPLETED" if "error" not in out else ("CANCELLED" if out["error"] == "cancelled" else "FAILED")
            if job["status"] == "FAILED":
                job["error"] = out["error"]
        except Exception as e:  # noqa: BLE001
            job["status"], job["error"] = "FAILED", repr(e)
        job["executionTime"] = int((time.time() - t0) * 1000)
        if job.get("webhook"):
            body = {k: job.get(k) for k in ("id", "status", "executionTime", "delayTime", "output", "error")}
            try:
                requests.post(job["webhook"], json=body, timeout=30)
            except requests.RequestException as e:
                print("webhook failed", e)


class H(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict) -> None:
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/run":
            jid = uuid.uuid4().hex
            JOBS[jid] = {"id": jid, "status": "IN_QUEUE", "input": body["input"], "webhook": body.get("webhook"), "delayTime": 0}
            Q.put(jid)
            return self._send(200, {"id": jid, "status": "IN_QUEUE"})
        if self.path.startswith("/cancel/"):
            jid = self.path.split("/")[-1]
            if jid in JOBS and JOBS[jid]["status"] == "IN_QUEUE":
                JOBS[jid]["status"] = "CANCELLED"
            return self._send(200, {"id": jid, "status": JOBS.get(jid, {}).get("status")})
        self._send(404, {"error": "not found"})

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/status/"):
            jid = self.path.split("/")[-1]
            j = JOBS.get(jid)
            if not j:
                return self._send(404, {"error": "not found"})
            return self._send(200, {k: j.get(k) for k in ("id", "status", "executionTime", "delayTime", "output", "error")})
        if self.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def log_message(self, *a) -> None:
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8789)
    a = ap.parse_args()
    threading.Thread(target=worker, daemon=True).start()
    print(f"dev GPU backend on :{a.port}")
    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
