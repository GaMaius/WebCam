// Turns a MediaPipe face mesh + the captured pixels into a compact, textual
// description of the face.
//
// Why text: PokéMatch's judge is `openai/gpt-oss-120b` on Groq, which is a
// TEXT-ONLY model — it never sees the photo. Everything the judge knows about
// the person has to be measured here and written down. So this file is the
// actual input quality ceiling of the app: a descriptor that isn't measured
// here cannot influence the result no matter how good the prompt is.
//
// Landmark indices are the standard 468-point FaceMesh topology. The face
// oval / eyebrow / lip points are the same verified ones lib/faceShape.ts
// documents; the eye, nose and mouth points below are the commonly cited
// ones for those parts. This is a "fun" descriptor, not a clinical
// measurement — see the same caveat in lib/faceShape.ts.

import { classifyFaceShape, computeFaceGeometry, type FaceShape, type Point2D } from "../faceShape.ts";
import { itaDegrees, rgbToHex, rgbToLab } from "../colorSpace.ts";
import { classifyIta, classifyUndertone, type ItaCategory, type Undertone } from "../personalColor.ts";

const LM = {
  FOREHEAD_TOP: 10,
  MID_FOREHEAD: 151,
  CHIN: 152,
  CHEEK_RIGHT: 234,
  CHEEK_LEFT: 454,
  JAW_RIGHT: 58,
  JAW_LEFT: 288,
  TEMPLE_RIGHT: 54,
  TEMPLE_LEFT: 284,
  // Right eye (image-left): outer/inner corner, upper/lower lid.
  R_EYE_OUT: 33,
  R_EYE_IN: 133,
  R_EYE_UP: 159,
  R_EYE_LOW: 145,
  // Left eye (image-right).
  L_EYE_IN: 362,
  L_EYE_OUT: 263,
  L_EYE_UP: 386,
  L_EYE_LOW: 374,
  // Brow apex above each eye.
  R_BROW: 105,
  L_BROW: 334,
  R_BROW_IN: 107,
  R_BROW_OUT: 46,
  // Nose alae.
  NOSE_R: 129,
  NOSE_L: 358,
  NOSE_TIP: 1,
  // Mouth: corners + outer upper/lower lip midpoints.
  MOUTH_R: 61,
  MOUTH_L: 291,
  LIP_TOP: 0,
  LIP_BOTTOM: 17,
  LIP_INNER: 13,
  // Cheek centers (used for skin sampling, away from shadow/beard).
  CHEEK_PAD_R: 50,
  CHEEK_PAD_L: 280,
} as const;

export interface SkinFeature {
  hex: string;
  ita: number;
  itaCategory: ItaCategory;
  undertone: Undertone;
}

export interface FaceFeatures {
  /** Rule-based shape class from lib/faceShape.ts. */
  shape: FaceShape;
  lengthToWidth: number;
  jawAngle: number;
  /** Upper / middle / lower facial thirds, each ~1.0 when balanced. */
  thirds: [number, number, number];
  jawToCheek: number;
  foreheadToCheek: number;
  /** Eye aperture: lid gap / eye width. Higher = rounder, wider eyes. */
  eyeOpenness: number;
  /** Single eye width relative to face width. */
  eyeWidthRatio: number;
  /** Inter-eye gap / eye width. ~1.0 is "one eye apart" (the classic ideal). */
  eyeSpacing: number;
  /** Outer-corner tilt in degrees. Positive = outer corner sits higher. */
  eyeSlant: number;
  /** Brow-to-lid gap relative to eye height. Higher = brows sit high/open look. */
  browHeight: number;
  /** Brow tilt in degrees. Positive = arched up toward the temple. */
  browAngle: number;
  noseWidthRatio: number;
  mouthWidthRatio: number;
  /** Lip height / mouth width. Higher = fuller lips. */
  lipFullness: number;
  skin: SkinFeature;
  hairHex: string;
  /** 0-1 relative luminance of the hair sample. Low = dark hair. */
  hairBrightness: number;
  lipHex: string;
}

export interface RgbSample {
  r: number;
  g: number;
  b: number;
}

/** Reads an averaged color from a disc of `radius` px around a normalized point. */
export function sampleDisc(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  nx: number,
  ny: number,
  radius: number
): RgbSample {
  const cx = Math.round(nx * w);
  const cy = Math.round(ny * h);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const rr = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > rr) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  if (!n) return { r: 128, g: 128, b: 128 };
  return { r: r / n, g: g / n, b: b / n };
}

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mid(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Angle of b→a in degrees, with the screen's y-down axis flipped so that a
 * positive value means "the outer end sits higher on the face". */
function tiltDegrees(inner: Point2D, outer: Point2D): number {
  return (Math.atan2(inner.y - outer.y, Math.abs(outer.x - inner.x) || 1e-6) * 180) / Math.PI;
}

function luminance({ r, g, b }: RgbSample): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Measures the face. `landmarks` are MediaPipe's per-axis normalized coords;
 * `frameW`/`frameH` are the pixel dimensions of `pixels` (which must be the
 * same frame the landmarks came from) so distances can be aspect-corrected —
 * normalized coords divide x by width and y by height, which skews every
 * ratio below if used directly.
 */
export function extractFaceFeatures(
  landmarks: Point2D[],
  pixels: Uint8ClampedArray,
  frameW: number,
  frameH: number
): FaceFeatures | null {
  if (!landmarks || landmarks.length < 468) return null;

  // Aspect-correct copy for every geometric measurement.
  const px: Point2D[] = landmarks.map((p) => ({ x: p.x * frameW, y: p.y * frameH }));
  const at = (i: number) => px[i];

  const geometry = computeFaceGeometry(px);
  const shape = classifyFaceShape(px);

  const faceW = dist(at(LM.CHEEK_RIGHT), at(LM.CHEEK_LEFT)) || 1e-6;
  const jawW = dist(at(LM.JAW_RIGHT), at(LM.JAW_LEFT));
  const foreheadW = dist(at(LM.TEMPLE_RIGHT), at(LM.TEMPLE_LEFT));

  const rEyeW = dist(at(LM.R_EYE_OUT), at(LM.R_EYE_IN));
  const lEyeW = dist(at(LM.L_EYE_OUT), at(LM.L_EYE_IN));
  const eyeW = (rEyeW + lEyeW) / 2 || 1e-6;
  const rEyeH = dist(at(LM.R_EYE_UP), at(LM.R_EYE_LOW));
  const lEyeH = dist(at(LM.L_EYE_UP), at(LM.L_EYE_LOW));
  const eyeH = (rEyeH + lEyeH) / 2;

  const eyeSlant =
    (tiltDegrees(at(LM.R_EYE_IN), at(LM.R_EYE_OUT)) + tiltDegrees(at(LM.L_EYE_IN), at(LM.L_EYE_OUT))) / 2;
  const browAngle = tiltDegrees(at(LM.R_BROW_IN), at(LM.R_BROW_OUT));
  const browGap = (dist(at(LM.R_BROW), at(LM.R_EYE_UP)) + dist(at(LM.L_BROW), at(LM.L_EYE_UP))) / 2;

  const mouthW = dist(at(LM.MOUTH_R), at(LM.MOUTH_L));
  const lipH = dist(at(LM.LIP_TOP), at(LM.LIP_BOTTOM));

  // Color samples use the ORIGINAL normalized coords (they index the frame
  // directly). Radius scales with face size so a small face isn't averaged
  // across the background.
  const faceNormW = Math.abs(landmarks[LM.CHEEK_LEFT].x - landmarks[LM.CHEEK_RIGHT].x);
  const radius = Math.max(2, Math.round(faceNormW * frameW * 0.05));
  const sample = (i: number) => sampleDisc(pixels, frameW, frameH, landmarks[i].x, landmarks[i].y, radius);

  const cheekR = sample(LM.CHEEK_PAD_R);
  const cheekL = sample(LM.CHEEK_PAD_L);
  const brow = sample(LM.MID_FOREHEAD);
  const skinRgb = {
    r: (cheekR.r + cheekL.r + brow.r) / 3,
    g: (cheekR.g + cheekL.g + brow.g) / 3,
    b: (cheekR.b + cheekL.b + brow.b) / 3,
  };
  const lab = rgbToLab(skinRgb.r, skinRgb.g, skinRgb.b);
  const ita = itaDegrees(lab);

  // Hair sits above the forehead by ~18% of the face height; clamped into frame.
  const faceNormH = Math.abs(landmarks[LM.CHIN].y - landmarks[LM.FOREHEAD_TOP].y);
  const hairY = Math.max(0.01, landmarks[LM.FOREHEAD_TOP].y - faceNormH * 0.18);
  const hairRgb = sampleDisc(pixels, frameW, frameH, landmarks[LM.FOREHEAD_TOP].x, hairY, radius);
  const lipRgb = sampleDisc(pixels, frameW, frameH, landmarks[LM.LIP_INNER].x, landmarks[LM.LIP_INNER].y, Math.max(2, Math.round(radius * 0.5)));

  const eyeCenterR = mid(at(LM.R_EYE_OUT), at(LM.R_EYE_IN));
  const eyeCenterL = mid(at(LM.L_EYE_OUT), at(LM.L_EYE_IN));

  const round = (v: number, d = 2) => Number(v.toFixed(d));

  return {
    shape,
    lengthToWidth: round(geometry.lengthToWidth),
    jawAngle: round(geometry.jawAngle, 1),
    thirds: [round(geometry.thirds[0]), round(geometry.thirds[1]), round(geometry.thirds[2])],
    jawToCheek: round(jawW / faceW),
    foreheadToCheek: round(foreheadW / faceW),
    eyeOpenness: round(eyeH / eyeW),
    eyeWidthRatio: round(eyeW / faceW),
    eyeSpacing: round(dist(eyeCenterR, eyeCenterL) / eyeW - 1),
    eyeSlant: round(eyeSlant, 1),
    browHeight: round(browGap / (eyeH || 1e-6)),
    browAngle: round(browAngle, 1),
    noseWidthRatio: round(dist(at(LM.NOSE_R), at(LM.NOSE_L)) / faceW),
    mouthWidthRatio: round(mouthW / faceW),
    lipFullness: round(lipH / (mouthW || 1e-6)),
    skin: {
      hex: rgbToHex(skinRgb.r, skinRgb.g, skinRgb.b),
      ita: round(ita, 1),
      itaCategory: classifyIta(ita),
      undertone: classifyUndertone(lab),
    },
    hairHex: rgbToHex(hairRgb.r, hairRgb.g, hairRgb.b),
    hairBrightness: round(luminance(hairRgb)),
    lipHex: rgbToHex(lipRgb.r, lipRgb.g, lipRgb.b),
  };
}

const SHAPE_KO: Record<FaceShape, string> = {
  oval: "계란형",
  round: "둥근형",
  square: "각진형(사각)",
  heart: "하트형(이마 넓고 턱 좁음)",
  oblong: "긴 얼굴형",
  diamond: "다이아몬드형(광대 강조)",
};

const UNDERTONE_KO: Record<Undertone, string> = {
  warm: "웜(노란기)",
  cool: "쿨(붉은·푸른기)",
  neutral: "뉴트럴",
};

const ITA_KO: Record<ItaCategory, string> = {
  "very-light": "매우 밝음",
  light: "밝음",
  intermediate: "중간",
  tan: "약간 어두움",
  brown: "어두움",
  dark: "매우 어두움",
};

/** Renders the measurements as the Korean prose block the judge reads.
 * Each line pairs the raw number with a plain-language reading, because the
 * model reasons much better about "눈이 큰 편" than about "0.42". */
/**
 * Compact English descriptor sent alongside the photo.
 *
 * ⚠️ ENGLISH ON PURPOSE, like the prompt — this model's tokenizer falls back
 * to bytes for Hangul at roughly 2.7 tokens per character against 0.25 for
 * English. The Korean version of this cost ~490 tokens; this costs under 100,
 * and that difference decides whether two scans fit inside the 8K per-minute
 * cap or only one does.
 *
 * Terse by design. The photo is what's being judged; these are the things a
 * glance gets wrong — exact ratios and a measured skin tone.
 */
export function describeFaceFeatures(f: FaceFeatures): string {
  const cmp = (v: number, lo: number, hi: number, low: string, mid: string, high: string) =>
    v < lo ? low : v > hi ? high : mid;

  return [
    `face ${f.shape}, length/width ${f.lengthToWidth}, jaw angle ${f.jawAngle}deg`,
    `jaw/cheek ${f.jawToCheek} (${cmp(f.jawToCheek, 0.78, 0.88, "narrow", "average", "wide/square")})`,
    `forehead/cheek ${f.foreheadToCheek} (${cmp(f.foreheadToCheek, 0.86, 0.94, "narrow", "average", "broad")})`,
    `thirds upper:mid:lower ${f.thirds.join(":")} (1.0 = balanced)`,
    `eye width ${f.eyeWidthRatio}, openness ${f.eyeOpenness} (${cmp(f.eyeOpenness, 0.3, 0.4, "narrow", "average", "large round")})`,
    `eye spacing ${f.eyeSpacing} (${cmp(f.eyeSpacing, -0.1, 0.15, "close-set", "average", "wide-set")})`,
    `eye tilt ${f.eyeSlant}deg (${cmp(f.eyeSlant, -1, 3, "downturned/soft", "level", "upturned/sharp")})`,
    `brow height ${f.browHeight}, angle ${f.browAngle}deg (${cmp(f.browAngle, 2, 8, "straight", "slight arch", "arched")})`,
    `nose width ${f.noseWidthRatio} (${cmp(f.noseWidthRatio, 0.24, 0.3, "narrow", "average", "broad")})`,
    `mouth width ${f.mouthWidthRatio}, lips ${f.lipFullness} (${cmp(f.lipFullness, 0.25, 0.36, "thin", "average", "full")})`,
    `skin ${f.skin.hex} ITA ${f.skin.ita}deg, undertone ${f.skin.undertone}`,
    `hair ${f.hairHex} brightness ${f.hairBrightness} (0 = black, 1 = blond)`,
    `lips ${f.lipHex}`,
  ].join("\n");
}

