// Ambient-light (Gray World) correction and a simplified warm/cool +
// 4-season personal-color classification from CIELAB coordinates.
//
// Personal-color typing has no single universally agreed-upon algorithm
// even among professional colorists (real consultations use physical
// fabric drapes under controlled light) — this is a directionally
// reasonable, clearly-documented heuristic for a fun web feature, not a
// clinical or professional-grade classification.

import type { Lab } from "./colorSpace";
import type { SeasonTone } from "./types";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Gray World white balance: assumes the average reflectance of the scene
 * (captured via the back camera pointed at the surroundings) should be
 * neutral gray. Any deviation of that average from gray reveals the
 * illuminant's color cast, which is then divided back out of the skin
 * sample so the corrected color better reflects the skin's true
 * reflectance rather than the ambient light's tint.
 */
export function grayWorldCorrection(skin: Rgb, ambient: Rgb): Rgb {
  const avgAmbient = (ambient.r + ambient.g + ambient.b) / 3;
  const scale = (channel: number) => (channel <= 0 ? 1 : avgAmbient / channel);
  const clamp = (v: number) => Math.max(0, Math.min(255, v));

  return {
    r: clamp(skin.r * scale(ambient.r)),
    g: clamp(skin.g * scale(ambient.g)),
    b: clamp(skin.b * scale(ambient.b)),
  };
}

export type Undertone = "warm" | "cool" | "neutral";

/** b* (yellow-blue) vs a* (red-green): more yellow-relative-to-red reads
 * warmer, more red/blue-relative-to-yellow reads cooler. */
export function classifyUndertone(lab: Lab, threshold = 3): Undertone {
  const diff = lab.b - lab.a;
  if (diff > threshold) return "warm";
  if (diff < -threshold) return "cool";
  return "neutral";
}

/** Combines undertone with lightness (L*) into a 4-season label. Neutral
 * undertones fall back to whichever raw sign (even below the confident
 * threshold) the color leans toward, so every input still gets an answer. */
export function classifySeason(lab: Lab, undertone: Undertone, lightThreshold = 60): SeasonTone {
  const isLight = lab.L >= lightThreshold;
  const leansWarm = undertone === "warm" || (undertone === "neutral" && lab.b >= lab.a);

  if (leansWarm) return isLight ? "spring-warm" : "autumn-warm";
  return isLight ? "summer-cool" : "winter-cool";
}
