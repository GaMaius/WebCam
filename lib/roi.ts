// Derives forehead/cheek sampling regions from MediaPipe face landmarks.
// Rather than hardcoding a handful of the 478-point face-mesh indices
// (easy to get subtly wrong from memory), we take the bounding box of ALL
// returned landmarks and carve out proportional regions within it — a
// simple, robust way to land on the same anatomical areas regardless of
// exact topology indexing.

export interface RoiRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NormalizedLandmark {
  x: number;
  y: number;
}

export interface RoiRegions {
  forehead: RoiRegion;
  leftCheek: RoiRegion;
  rightCheek: RoiRegion;
  /**
   * The front of the neck, below the chin — the carotid region.
   *
   * Genuinely one of the stronger rPPG sites: the carotids run close to the
   * surface, so the pulsatile component there is large. It's optional, though —
   * a high collar, a beard, or a tight camera framing puts it out of shot — so
   * callers must check it's actually visible skin before using it (see
   * `isRegionUsableSkin`) rather than averaging in a collar.
   */
  neck: RoiRegion;
  /** Overall face bounding box center, in pixel coordinates — used for motion tracking. */
  center: { x: number; y: number };
}

/** Minimum skin coverage before an optional region is trusted. Below this the
 * rectangle is mostly clothing, hair, beard or background. */
export const MIN_SKIN_RATIO = 0.55;

/**
 * Whether an optional ROI is really exposed skin and inside the frame.
 *
 * Used to decide at runtime whether the neck contributes. This is what makes
 * "your neck is included when it's visible" an accurate statement instead of a
 * hopeful one.
 */
export function isRegionUsableSkin(
  region: RoiRegion,
  sample: SkinSample,
  frameWidth: number,
  frameHeight: number
): boolean {
  const inFrame =
    region.x >= 0 &&
    region.y >= 0 &&
    region.x + region.w <= frameWidth &&
    region.y + region.h <= frameHeight &&
    region.w > 4 &&
    region.h > 4;
  return inFrame && sample.skinRatio >= MIN_SKIN_RATIO;
}

export function computeRoiRegions(
  landmarks: NormalizedLandmark[],
  frameWidth: number,
  frameHeight: number
): RoiRegions {
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const lm of landmarks) {
    if (lm.x < minX) minX = lm.x;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.y > maxY) maxY = lm.y;
  }
  const faceW = Math.max(1e-6, maxX - minX);
  const faceH = Math.max(1e-6, maxY - minY);

  const region = (rx: number, ry: number, rw: number, rh: number): RoiRegion => ({
    x: (minX + rx * faceW) * frameWidth,
    y: (minY + ry * faceH) * frameHeight,
    w: rw * faceW * frameWidth,
    h: rh * faceH * frameHeight,
  });

  return {
    // Upper-middle of the face box: glabella/forehead, below the hairline.
    forehead: region(0.32, 0.08, 0.36, 0.14),
    // Image-space left side (== subject's right cheek when facing the camera).
    leftCheek: region(0.1, 0.5, 0.22, 0.16),
    // Image-space right side (== subject's left cheek).
    rightCheek: region(0.68, 0.5, 0.22, 0.16),
    // Just below the chin, centred on the throat. Sits OUTSIDE the face box
    // (ry > 1), so it can fall off the bottom of the frame — that's expected and
    // is what isRegionUsableSkin exists to catch.
    neck: region(0.3, 1.04, 0.4, 0.18),
    center: {
      x: (minX + faceW / 2) * frameWidth,
      y: (minY + faceH / 2) * frameHeight,
    },
  };
}

/**
 * The face crop box the rPPG network sees: the tight face bounding
 * box enlarged by `coef` around its own center, matching this checkpoint's
 * training config (CROP_FACE.LARGE_BOX_COEF: 1.5), clamped to frame bounds.
 */
export function computeFaceCropBox(
  landmarks: NormalizedLandmark[],
  frameWidth: number,
  frameHeight: number,
  coef = 1.5
): RoiRegion {
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const lm of landmarks) {
    if (lm.x < minX) minX = lm.x;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.y > maxY) maxY = lm.y;
  }

  const pxMinX = minX * frameWidth;
  const pxMaxX = maxX * frameWidth;
  const pxMinY = minY * frameHeight;
  const pxMaxY = maxY * frameHeight;

  const cx = (pxMinX + pxMaxX) / 2;
  const cy = (pxMinY + pxMaxY) / 2;
  const w = (pxMaxX - pxMinX) * coef;
  const h = (pxMaxY - pxMinY) * coef;

  const x = Math.max(0, Math.min(frameWidth, cx - w / 2));
  const y = Math.max(0, Math.min(frameHeight, cy - h / 2));
  const clampedW = Math.min(w, frameWidth - x);
  const clampedH = Math.min(h, frameHeight - y);

  return { x, y, w: clampedW, h: clampedH };
}

export interface RgbMean {
  r: number;
  g: number;
  b: number;
}

/** Reads the average RGB of a region from a 2D canvas context, clamped to
 * the canvas bounds so an ROI that drifts to the frame edge doesn't throw. */
export function sampleRegionMean(
  ctx: CanvasRenderingContext2D,
  region: RoiRegion,
  canvasWidth: number,
  canvasHeight: number
): RgbMean {
  const x = Math.max(0, Math.min(canvasWidth - 1, Math.floor(region.x)));
  const y = Math.max(0, Math.min(canvasHeight - 1, Math.floor(region.y)));
  const w = Math.max(1, Math.min(canvasWidth - x, Math.floor(region.w)));
  const h = Math.max(1, Math.min(canvasHeight - y, Math.floor(region.h)));

  const { data } = ctx.getImageData(x, y, w, h);
  let r = 0;
  let g = 0;
  let b = 0;
  const pixelCount = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return { r: r / pixelCount, g: g / pixelCount, b: b / pixelCount };
}

export interface SkinSample extends RgbMean {
  /** Fraction of the ROI's pixels that classified as skin (0-1) — a validity
   * signal: a low ratio means the rectangle caught hair/shadow/background. */
  skinRatio: number;
}

/**
 * YCbCr skin-color gate. Chroma-based (Cr 133-173, Cb 77-127) so it stays
 * reasonably robust across skin tones — far less lightness-biased than the
 * classic Kovac RGB rules — while rejecting eyebrows, hair, shadow, and
 * background that a plain rectangular average would fold into the sample.
 */
export function isSkinPixel(r: number, g: number, b: number): boolean {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cr >= 133 && cr <= 173 && cb >= 77 && cb <= 127;
}

/**
 * Per-pixel skin-masked mean of an ROI: keeps only skin-classified pixels,
 * then trims the darkest and brightest 10% by luminance (drops residual
 * shadow/eyebrow and specular-highlight pixels) before averaging. This is
 * the real "skin mask" the personal-color analysis samples from, rather than
 * a flat rectangular average. Falls back to the plain average when too few
 * pixels classify as skin, so it never returns an empty sample.
 */
export function sampleRegionSkinMean(
  ctx: CanvasRenderingContext2D,
  region: RoiRegion,
  canvasWidth: number,
  canvasHeight: number
): SkinSample {
  const x = Math.max(0, Math.min(canvasWidth - 1, Math.floor(region.x)));
  const y = Math.max(0, Math.min(canvasHeight - 1, Math.floor(region.y)));
  const w = Math.max(1, Math.min(canvasWidth - x, Math.floor(region.w)));
  const h = Math.max(1, Math.min(canvasHeight - y, Math.floor(region.h)));

  const { data } = ctx.getImageData(x, y, w, h);
  const totalPixels = data.length / 4;

  // Collect skin pixels with their luminance for the outlier trim.
  const skin: { r: number; g: number; b: number; luma: number }[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (isSkinPixel(r, g, b)) {
      skin.push({ r, g, b, luma: 0.299 * r + 0.587 * g + 0.114 * b });
    }
  }
  const skinRatio = totalPixels > 0 ? skin.length / totalPixels : 0;

  // Too little skin in the ROI to trust the mask — fall back to a plain
  // average of the whole region rather than returning garbage.
  if (skin.length < Math.max(8, totalPixels * 0.15)) {
    const plain = sampleRegionMean(ctx, region, canvasWidth, canvasHeight);
    return { ...plain, skinRatio };
  }

  // Trim the darkest/brightest 10% (shadow/eyebrow & specular) then average.
  skin.sort((p, q) => p.luma - q.luma);
  const lo = Math.floor(skin.length * 0.1);
  const hi = Math.ceil(skin.length * 0.9);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = lo; i < hi; i++) {
    r += skin[i].r;
    g += skin[i].g;
    b += skin[i].b;
    n += 1;
  }
  if (n === 0) n = 1;
  return { r: r / n, g: g / n, b: b / n, skinRatio };
}

/**
 * Draws a region of the source video, scaled to `size x size`, onto a
 * scratch canvas and reads it back as a flat channel-last RGB Float32Array
 * — the frame representation lib/heartpulse/tsCan.ts's preprocessing expects.
 */
export function sampleRegionAsRgbFrame(
  source: CanvasImageSource,
  region: RoiRegion,
  scratchCanvas: HTMLCanvasElement,
  size: number
): Float32Array {
  if (scratchCanvas.width !== size || scratchCanvas.height !== size) {
    scratchCanvas.width = size;
    scratchCanvas.height = size;
  }
  const ctx = scratchCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return new Float32Array(size * size * 3);

  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const out = new Float32Array(size * size * 3);
  for (let p = 0, i = 0; p < size * size; p++, i += 4) {
    out[p * 3] = data[i];
    out[p * 3 + 1] = data[i + 1];
    out[p * 3 + 2] = data[i + 2];
  }
  return out;
}
