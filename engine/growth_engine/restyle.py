"""Deterministic, geometry-preserving environment restyle.

Every output pixel is computed from the *same* input pixel: no generative model
redraws the frame, so architecture, door positions, floor tile pattern and
camera motion are preserved by construction.

Repaint model (per region r, in linear light):
    shading(x)  = Y(I(x)) / Y(A_r)            # original light + texture on the surface
    out(x)      = T_r * shading(x) * tint     # new paint colour lit by the same light
A_r (the surface's original albedo estimate) is a single constant per clip, so
there is no frame-to-frame normalisation and therefore no flicker.

Relight is a fixed global grade (white balance, exposure, contrast, practical
light bloom, vignette) applied identically to every frame.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .segment import REGION_ORDER, guided_upsample

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055).astype(np.float32)


def hex_to_linear(hex_color: str) -> np.ndarray:
    h = hex_color.lstrip("#")
    rgb = np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0
    return srgb_to_linear(rgb)


def kelvin_rgb(kelvin: float) -> np.ndarray:
    """Approximate blackbody RGB (linear), normalised to unit luminance."""
    t = kelvin / 100.0
    r = 255 if t <= 66 else 329.698727446 * (t - 60) ** -0.1332047592
    g = 99.4708025861 * np.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * (t - 60) ** -0.0755148492
    b = 255 if t >= 66 else (0 if t <= 19 else 138.5177312231 * np.log(t - 10) - 305.0447927307)
    rgb = srgb_to_linear(np.clip(np.array([r, g, b], np.float32), 0, 255) / 255.0)
    return rgb / float(rgb @ LUMA)


@dataclass
class Surface:
    color: str | None = None        # hex paint colour; None = keep original
    finish: float = 0.0             # -1 (textured) .. 0 (as shot) .. 1 (smooth, fresh paint)
    strength: float = 1.0           # 0..1 blend with original


@dataclass
class Lighting:
    temperature: float = 0.0        # -1 cool .. +1 warm (relative white-balance shift)
    exposure: float = 0.0           # stops
    contrast: float = 0.0           # -1..1
    saturation: float = 0.0         # -1..1
    black_lift: float = 0.0         # 0..1 (filmic lifted blacks)
    shadow_tint: str | None = None  # hex, toned into shadows (e.g. teal for cinematic night)
    practical_glow: float = 0.0     # 0..1 bloom around light fixtures
    practical_kelvin: float = 3000  # colour of the bloom
    vignette: float = 0.0           # 0..1
    ambient_kelvin: float = 3000    # colour of the light already in the scene


@dataclass
class RestyleParams:
    wall: Surface = field(default_factory=Surface)
    ceiling: Surface = field(default_factory=Surface)
    door: Surface = field(default_factory=Surface)
    floor: Surface = field(default_factory=Surface)  # default: untouched
    lighting: Lighting = field(default_factory=Lighting)
    protect_people: bool = True

    @staticmethod
    def from_dict(d: dict) -> "RestyleParams":
        p = RestyleParams()
        for k in ("wall", "ceiling", "door", "floor"):
            if k in d and d[k] is not None:
                setattr(p, k, Surface(**{kk: v for kk, v in d[k].items() if kk in Surface.__annotations__}))
        if d.get("lighting"):
            p.lighting = Lighting(**{k: v for k, v in d["lighting"].items() if k in Lighting.__annotations__})
        p.protect_people = d.get("protect_people", True)
        return p


def _guided_self(x: np.ndarray, radius: int, eps: float) -> np.ndarray:
    k = (2 * radius + 1, 2 * radius + 1)
    m = cv2.blur(x, k)
    v = cv2.blur(x * x, k) - m * m
    a = v / (v + eps)
    b = m - a * m
    return cv2.blur(a, k) * x + cv2.blur(b, k)


class Restyler:
    """Holds per-clip constants (albedo estimates) so every frame uses identical maths."""

    def __init__(self, params: RestyleParams, frames_sample: list[np.ndarray], probs_sample: list[np.ndarray]):
        self.p = params
        self.albedo: dict[str, float] = {}
        # Estimate each surface's original reflectance luminance once per clip:
        # a robust (median) luminance over confidently-labelled pixels, sampled across the clip.
        for name in ("wall", "ceiling", "door", "floor"):
            ri = REGION_ORDER.index(name)
            vals = []
            for f, pr in zip(frames_sample, probs_sample):
                m = cv2.resize(pr[ri].astype(np.float32), (f.shape[1], f.shape[0])) > 0.8
                if m.sum() > 500:
                    lin = srgb_to_linear(f[m].astype(np.float32) / 255.0)
                    vals.append(lin @ LUMA)
            if vals:
                v = np.concatenate(vals)
                # Use a high percentile: in night footage surfaces are mostly in shadow, and the
                # brighter, directly lit part best represents "paint under light".
                self.albedo[name] = float(np.percentile(v, 70)) + 1e-4
        lp = self.p.lighting
        # Assumed reflectance of the original paint (mid-tone emulsion) and colour of the scene's
        # practical light, used to light the new paint consistently with the footage.
        self.ref_reflectance = 0.22
        self.light_rgb = 0.3 + 0.7 * self._estimate_illuminant(frames_sample, probs_sample)
        self.wb = kelvin_rgb(6500 - 2200 * lp.temperature) / kelvin_rgb(6500)
        self.wb /= float(self.wb @ LUMA)
        self.glow_rgb = kelvin_rgb(lp.practical_kelvin)
        self.shadow_rgb = hex_to_linear(lp.shadow_tint) if lp.shadow_tint else None
        self._vig = None

    def _estimate_illuminant(self, frames, probs) -> np.ndarray:
        """Colour of the light in the scene, read from surfaces that are usually white (ceiling),
        falling back to the brightest non-fixture pixels. Normalised to unit luminance."""
        samples = []
        ci, li = REGION_ORDER.index("ceiling"), REGION_ORDER.index("light")
        for f, pr in zip(frames, probs):
            lin = srgb_to_linear(f.astype(np.float32) / 255.0)
            ceil = cv2.resize(pr[ci].astype(np.float32), (f.shape[1], f.shape[0])) > 0.8
            fixture = cv2.resize(pr[li].astype(np.float32), (f.shape[1], f.shape[0])) > 0.3
            Y = lin @ LUMA
            m = ceil & ~fixture & (Y < 0.95) & (Y > 0.02)
            if m.sum() < 2000:
                m = (~fixture) & (Y > np.percentile(Y, 95)) & (Y < 0.95)
            if m.sum() > 200:
                samples.append(np.median(lin[m], axis=0))
        if not samples:
            return kelvin_rgb(self.p.lighting.ambient_kelvin)
        rgb = np.median(np.stack(samples), axis=0)
        rgb = rgb / max(float(rgb @ LUMA), 1e-4)
        # Limit to plausible light colours (avoid locking onto a coloured ceiling).
        grey = np.ones(3, np.float32)
        return (grey + np.clip(rgb - grey, -0.6, 0.6)).astype(np.float32)

    # -- surfaces ---------------------------------------------------------
    def _repaint(self, lin: np.ndarray, alpha: np.ndarray, name: str, s: Surface) -> np.ndarray:
        if s.color is None and s.finish == 0.0:
            return lin
        Y = lin @ LUMA
        out_Y = Y
        if s.finish:
            # Edge-preserving split of luminance into lighting (base) and surface texture (detail).
            # Smoothing the detail = fresh, even paint; it never blurs across edges, and only acts
            # deep inside the region (alpha**3), so door frames / floor edges stay pixel-exact.
            logY = np.log(Y + 1e-4)
            base = _guided_self(logY, radius=max(4, Y.shape[1] // 160), eps=0.02)
            k = 0.85 * s.finish * alpha ** 3
            out_Y = np.exp(base + (logY - base) * (1.0 - k)) - 1e-4
        if s.color is not None:
            target = hex_to_linear(s.color)
            t_lum = float(target @ LUMA) + 1e-4
            # Paint lightness is relative to the original paint, damped so the shot's exposure and
            # night key survive (white paint brightens a dark wall ~1 stop, not 5).
            ratio = t_lum / self.ref_reflectance
            # Darker paint: near-physical. Lighter paint: damped to keep the night key.
            factor = float(np.clip(ratio ** (0.9 if ratio < 1 else 0.55), 0.08, 2.2))
            chroma = target * self.light_rgb
            chroma = chroma / (float(chroma @ LUMA) + 1e-6)
            new = (out_Y * factor)[..., None] * chroma[None, None, :]
        else:
            new = lin * ((out_Y + 1e-5) / (Y + 1e-5))[..., None]
        a = (alpha * s.strength)[..., None]
        return lin * (1 - a) + new * a

    # -- lighting ---------------------------------------------------------
    def _grade(self, lin: np.ndarray, light_alpha: np.ndarray | None = None) -> np.ndarray:
        lp = self.p.lighting
        out = lin * self.wb[None, None, :] * (2.0 ** lp.exposure)
        if lp.practical_glow > 0 and light_alpha is not None:
            Y = out @ LUMA
            hot = np.clip((Y - 0.5) / 0.5, 0, 1) * np.clip(light_alpha * 1.5, 0, 1)
            h, w = hot.shape
            bloom = cv2.GaussianBlur(hot, (0, 0), max(h, w) * 0.012) + 0.5 * cv2.GaussianBlur(hot, (0, 0), max(h, w) * 0.05)
            out = out + lp.practical_glow * 0.12 * bloom[..., None] * self.glow_rgb[None, None, :]
        if lp.contrast:
            # Contrast around 18% grey in log space keeps the night key intact.
            out = 0.18 * np.power(np.clip(out, 1e-5, None) / 0.18, 1.0 + 0.35 * lp.contrast)
        if lp.saturation:
            Y = (out @ LUMA)[..., None]
            out = Y + (out - Y) * (1.0 + lp.saturation)
        if self.shadow_rgb is not None:
            Y = (out @ LUMA)[..., None]
            wgt = np.clip(1.0 - Y / 0.08, 0, 1) * 0.35
            out = out * (1 - wgt) + (Y * self.shadow_rgb / max(float(self.shadow_rgb @ LUMA), 1e-3)) * wgt
        if lp.black_lift:
            out = out * (1 - 0.03 * lp.black_lift) + 0.03 * lp.black_lift * 0.02
        if lp.vignette:
            if self._vig is None or self._vig.shape != out.shape[:2]:
                h, w = out.shape[:2]
                yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
                r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2) / np.sqrt(2)
                self._vig = (1 - np.clip(r - 0.35, 0, 1) ** 2 * 1.6).astype(np.float32)
            out = out * (1 - lp.vignette + lp.vignette * self._vig)[..., None]
        # Soft highlight shoulder: no hard clipping of lamps / bright paint.
        knee = 0.8
        out = np.where(out > knee, knee + (1 - knee) * np.tanh((out - knee) / (1 - knee)), out)
        return out

    def apply(self, frame: np.ndarray, probs: np.ndarray) -> np.ndarray:
        """frame: RGB uint8 (H, W, 3); probs: (R, h, w) fused region probabilities."""
        lin = srgb_to_linear(frame.astype(np.float32) / 255.0)
        alphas = {}
        for name in ("wall", "ceiling", "door", "floor", "person", "light"):
            alphas[name] = guided_upsample(probs[REGION_ORDER.index(name)], frame)
        keep = 1.0 - alphas["person"] if self.p.protect_people else np.ones_like(alphas["wall"])
        for name in ("ceiling", "wall", "door"):
            # Floor and light fixtures are hard-protected from repainting.
            keep_r = keep * (1.0 - alphas["floor"]) * (1.0 - alphas["light"])
            lin = self._repaint(lin, np.clip(alphas[name] * keep_r, 0, 1), name, getattr(self.p, name))
        if self.p.floor.color is not None or self.p.floor.finish:
            lin = self._repaint(lin, np.clip(alphas["floor"] * keep, 0, 1), "floor", self.p.floor)
        lin = self._grade(lin, alphas["light"])
        return (linear_to_srgb(lin) * 255.0 + 0.5).astype(np.uint8)
