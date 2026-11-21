"""Reusable looks for the Restyle Space tool (shared with the web app via presets.json)."""
import json
import os

with open(os.path.join(os.path.dirname(__file__), "presets.json")) as f:
    PRESETS: dict[str, dict] = json.load(f)


def resolve(preset: str | None, overrides: dict | None) -> dict:
    """Preset values with user overrides merged on top (per surface / lighting key)."""
    base = {k: (dict(v) if isinstance(v, dict) else v) for k, v in PRESETS.get(preset or "as-shot", PRESETS["as-shot"]).items()}
    for k, v in (overrides or {}).items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k] = {**base[k], **v}
        else:
            base[k] = v
    base.pop("label", None)
    return base
