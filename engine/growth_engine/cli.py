"""python -m growth_engine.cli INPUT OUTPUT --preset luxury-interior --mode preview"""
import argparse, json, sys
from .pipeline import run_restyle

ap = argparse.ArgumentParser()
ap.add_argument("input"); ap.add_argument("output")
ap.add_argument("--preset", default="luxury-interior")
ap.add_argument("--mode", default="preview", choices=["preview", "full"])
ap.add_argument("--aspect", default="original")
ap.add_argument("--overrides", default="{}")
ap.add_argument("--cache", default="/tmp/growth-cache")
a = ap.parse_args()
res = run_restyle(a.input, a.output, {"preset": a.preset, "mode": a.mode, "aspect": a.aspect,
                  "overrides": json.loads(a.overrides)}, a.cache,
                  progress=lambda p, m: print(f"{p*100:5.1f}% {m}", file=sys.stderr, flush=True))
print(json.dumps(res))
