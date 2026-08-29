// sRGB (D65) -> CIELAB conversion. Standard colorimetry pipeline:
// sRGB -> linear RGB -> CIE XYZ -> CIE L*a*b*.
// Reference: IEC 61966-2-1 (sRGB) + CIE 15:2004.

export interface Lab {
  L: number;
  a: number;
  b: number;
}

// sRGB -> CIE XYZ matrix (D65 reference white), IEC 61966-2-1.
const D65_XN = 0.95047;
const D65_YN = 1.0;
const D65_ZN = 1.08883;

function srgbChannelToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  const delta = 6 / 29;
  return t > delta ** 3 ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const rl = srgbChannelToLinear(r);
  const gl = srgbChannelToLinear(g);
  const bl = srgbChannelToLinear(b);

  const X = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const Y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const Z = rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041;

  const fx = labF(X / D65_XN);
  const fy = labF(Y / D65_YN);
  const fz = labF(Z / D65_ZN);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/**
 * Individual Typology Angle (Chardon et al. 1991; Del Bino) — the
 * dermatology-standard, objective skin-tone classifier derived from CIELAB:
 *   ITA° = arctan((L* − 50) / b*) × 180/π
 * Higher = lighter skin, lower = deeper. atan2 is used so a near-zero b*
 * can't blow up the ratio. Standard category boundaries (degrees):
 *   >55 very light · 41–55 light · 28–41 intermediate · 10–28 tan ·
 *   −30–10 brown · <−30 dark.
 */
export function itaDegrees(lab: Lab): number {
  return (Math.atan2(lab.L - 50, lab.b) * 180) / Math.PI;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const toHex = (v: number) => clamp(v).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
