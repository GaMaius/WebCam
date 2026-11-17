// Ambient-light (Gray World) correction and a simplified warm/cool +
// 4-season personal-color classification from CIELAB coordinates.
//
// Personal-color typing has no single universally agreed-upon algorithm
// even among professional colorists (real consultations use physical
// fabric drapes under controlled light) — this is a directionally
// reasonable, clearly-documented heuristic for a fun web feature, not a
// clinical or professional-grade classification.

import { itaDegrees, type Lab } from "./colorSpace.ts";
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

/**
 * Average per-channel standard deviation across a series of RGB samples.
 * Used as a measurement-quality signal: a shaky capture (head motion during
 * front skin sampling, hand motion during the rear ambient-light sampling)
 * shows up as high sample-to-sample variance, so this feeds directly into
 * PersonalFrame's confidence score instead of a fixed/assumed number.
 */
export function rgbSampleStdDev(samples: Rgb[]): number {
  if (samples.length < 2) return 0;
  const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const channelStdDev = (xs: number[]) => {
    const m = meanOf(xs);
    return Math.sqrt(meanOf(xs.map((x) => (x - m) ** 2)));
  };
  const rStd = channelStdDev(samples.map((s) => s.r));
  const gStd = channelStdDev(samples.map((s) => s.g));
  const bStd = channelStdDev(samples.map((s) => s.b));
  return (rStd + gStd + bStd) / 3;
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

// The six standard ITA° skin-tone categories (Chardon / Del Bino).
export type ItaCategory = "very-light" | "light" | "intermediate" | "tan" | "brown" | "dark";

export function classifyIta(ita: number): ItaCategory {
  if (ita > 55) return "very-light";
  if (ita > 41) return "light";
  if (ita > 28) return "intermediate";
  if (ita > 10) return "tan";
  if (ita > -30) return "brown";
  return "dark";
}

// Season light/deep split. We use ITA° (which folds in both L* lightness and
// b* warmth) rather than a bare L* threshold — a more principled, standard
// measure of skin depth. The 41° boundary is the dermatology light /
// intermediate line, which maps well onto the personal-color "light-season
// (spring/summer) vs deep-season (autumn/winter)" axis.
const SEASON_LIGHT_ITA = 41;

/** Combines undertone with skin depth (ITA°) into a 4-season label. Neutral
 * undertones fall back to whichever way the raw a*, b* balance leans, so
 * every input still gets an answer. */
export function classifySeason(lab: Lab, undertone: Undertone): SeasonTone {
  const isLight = itaDegrees(lab) >= SEASON_LIGHT_ITA;
  const leansWarm = undertone === "warm" || (undertone === "neutral" && lab.b >= lab.a);

  if (leansWarm) return isLight ? "spring-warm" : "autumn-warm";
  return isLight ? "summer-cool" : "winter-cool";
}
