// One Euro filter (Casiez, Roussel & Vogel, CHI 2012) for landmark streams.
//
// Why this and not the fixed per-frame slerp alone: a fixed lerp factor is a
// compromise baked in at one speed — low enough to hide jitter when the user is
// still, it lags visibly when they move fast, and its time constant changes with
// the frame rate (0.3 per frame is a different filter at 20fps than at 30fps).
// The One Euro filter adapts its cutoff to the signal's own speed: heavy
// smoothing while a landmark is nearly still (which is when jitter is visible),
// almost none while it moves fast (which is when lag is visible). It is the
// standard choice for exactly this — noisy pose estimates driving a cursor or
// an avatar — and it uses real timestamps, so it behaves the same at any fps.
//
// Kept import-free so it runs under `node --test`.

function alpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

export interface OneEuroParams {
  /** Cutoff (Hz) when the signal is still. Lower = smoother at rest. */
  minCutoff: number;
  /** How fast the cutoff rises with speed. Higher = less lag on fast motion. */
  beta: number;
  /** Cutoff (Hz) for the speed estimate itself. */
  dCutoff: number;
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  // Plain fields, not parameter properties: node --test strips types only and
  // rejects `constructor(private readonly p)`.
  private readonly p: OneEuroParams;

  constructor(params: OneEuroParams) {
    this.p = params;
  }

  /** `tMs` is a monotonic timestamp in milliseconds (performance.now()). */
  filter(value: number, tMs: number): number {
    if (this.x === null || !Number.isFinite(this.x)) {
      this.x = value;
      this.dx = 0;
      this.t = tMs;
      return value;
    }
    // Guard against a zero/negative step (same frame, clock hiccup): treat it
    // as one 60Hz tick rather than dividing by zero.
    const dt = tMs > this.t ? (tMs - this.t) / 1000 : 1 / 60;
    this.t = tMs;
    const rawDx = (value - this.x) / dt;
    const aD = alpha(this.p.dCutoff, dt);
    this.dx = aD * rawDx + (1 - aD) * this.dx;
    const cutoff = this.p.minCutoff + this.p.beta * Math.abs(this.dx);
    const a = alpha(cutoff, dt);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }
}

type Point = { x: number; y: number; z: number; visibility?: number };

/**
 * Filters a whole landmark list point by point. Allocates per-coordinate
 * filters lazily, and starts over whenever the list length changes or the
 * stream has been absent for `resetAfterMs` — re-acquiring a hand after it left
 * the frame must snap to the new position, not glide in from the old one.
 */
export class LandmarkSmoother {
  private filters: OneEuroFilter[] = [];
  private lastAt = -Infinity;
  private readonly p: OneEuroParams;
  private readonly resetAfterMs: number;

  constructor(params: OneEuroParams, resetAfterMs = 300) {
    this.p = params;
    this.resetAfterMs = resetAfterMs;
  }

  smooth<T extends Point>(points: T[] | undefined, tMs: number): T[] | undefined {
    if (!points || points.length === 0) return points;
    const needed = points.length * 3;
    if (this.filters.length !== needed || tMs - this.lastAt > this.resetAfterMs) {
      this.filters = Array.from({ length: needed }, () => new OneEuroFilter(this.p));
    }
    this.lastAt = tMs;
    return points.map((pt, i) => ({
      ...pt,
      x: this.filters[i * 3].filter(pt.x, tMs),
      y: this.filters[i * 3 + 1].filter(pt.y, tMs),
      z: this.filters[i * 3 + 2].filter(pt.z, tMs),
    }));
  }

  reset() {
    this.filters = [];
    this.lastAt = -Infinity;
  }
}

// Tuned per signal. Units matter: normalized landmarks live in [0,1] of the
// frame, world landmarks in meters, so the same beta means a different thing
// for each — speeds in m/s are smaller than in frame-widths/s for a hand near
// the camera, hence the larger beta on the metric sets.
/** Normalized (image-space) pose/hand/face landmarks. */
export const SMOOTH_IMAGE: OneEuroParams = { minCutoff: 1.2, beta: 8, dCutoff: 1 };
/** Metric world landmarks (pose/hand), which drive the arm aim and finger angles. */
export const SMOOTH_WORLD: OneEuroParams = { minCutoff: 1.2, beta: 20, dCutoff: 1 };
/** Face mesh. The head moves slowly and Kalidokit's head solve amplifies
 * landmark noise, so it gets a lower resting cutoff. */
export const SMOOTH_FACE: OneEuroParams = { minCutoff: 0.9, beta: 6, dCutoff: 1 };
