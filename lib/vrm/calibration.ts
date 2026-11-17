// Neutral-pose calibration ("보정") for VRM Capture.
//
// Every camera setup has a built-in bias the tracker can't know about:
//   - A laptop camera sits BELOW the eyes, so a user looking straight at the
//     screen reads as looking up — the avatar spends the whole session with its
//     chin raised. A camera off to one side does the same for yaw.
//   - People's resting faces differ. Some rest with eyes a little narrowed
//     (eyeBlink ≈ 0.3 at rest), some with lips slightly parted (jawOpen ≈ 0.15),
//     some with brows habitually raised. Fixed thresholds tuned on one face
//     leave the next person's avatar half-blinking or permanently surprised.
//   - A seated user's torso is rarely square to the camera, so the avatar
//     leans or twists while the user sits normally.
//
// Calibration records ~1.5 s of the user sitting naturally and looking at the
// screen, then subtracts that as the zero point: rotations are offset, and each
// blendshape is remapped so the user's own resting value becomes 0 while 1
// stays 1. It's the same idea as the "calibrate" button in desktop VTuber apps.
//
// Pure and import-free so it runs under `node --test`.

export type Euler3 = { x: number; y: number; z: number };

export interface CalibrationProfile {
  version: 1;
  /** Kalidokit Face.solve head rotation while looking at the screen. */
  head?: Euler3;
  /** Kalidokit Pose.solve hips rotation / spine while sitting naturally. */
  hips?: Euler3;
  spine?: Euler3;
  /** Resting ARKit blendshape scores, by category name. */
  blendshapes: Record<string, number>;
  /** ISO timestamp, shown in the UI. */
  createdAt: string;
}

/** One frame's solved values, as reported by the bridge while calibrating. */
export interface CalibrationSample {
  head?: Euler3;
  hips?: Euler3;
  spine?: Euler3;
  blendshapes?: { categoryName?: string; displayName?: string; score: number }[];
}

/** Fresh face frames needed for a usable profile. 12 is what 1.5 s yields even
 * on the low-fps schedule (face on every other frame at ~16fps). */
export const MIN_CALIBRATION_FRAMES = 12;
/** Never subtract more than this — a bigger "neutral" offset means the user
 * wasn't facing the screen, and baking it in would make the avatar face away. */
export const MAX_ROTATION_OFFSET = 0.6; // ~34°
/** A resting score above this isn't "resting" (eyes closed, mouth open during
 * calibration). Clamping keeps a bad sample from disabling the expression. */
export const MAX_BLENDSHAPE_BASELINE = 0.5;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function medianEuler(list: Euler3[]): Euler3 | undefined {
  if (list.length < MIN_CALIBRATION_FRAMES / 2) return undefined;
  const lim = MAX_ROTATION_OFFSET;
  return {
    x: clamp(median(list.map((e) => e.x)), -lim, lim),
    y: clamp(median(list.map((e) => e.y)), -lim, lim),
    z: clamp(median(list.map((e) => e.z)), -lim, lim),
  };
}

/**
 * Collapses the recorded samples into a profile, or null if there wasn't
 * enough face data to calibrate from. Median rather than mean: a blink or a
 * single bad detection during the window must not skew the baseline.
 */
export function buildCalibration(
  samples: CalibrationSample[],
  now: Date = new Date()
): CalibrationProfile | null {
  const heads = samples.flatMap((s) => (s.head ? [s.head] : []));
  if (heads.length < MIN_CALIBRATION_FRAMES) return null;

  const byName = new Map<string, number[]>();
  for (const s of samples) {
    for (const c of s.blendshapes ?? []) {
      const name = c.categoryName || c.displayName;
      if (!name || !Number.isFinite(c.score)) continue;
      const list = byName.get(name) ?? [];
      list.push(c.score);
      byName.set(name, list);
    }
  }
  const blendshapes: Record<string, number> = {};
  for (const [name, values] of byName) {
    blendshapes[name] = clamp(median(values), 0, MAX_BLENDSHAPE_BASELINE);
  }

  return {
    version: 1,
    head: medianEuler(heads),
    hips: medianEuler(samples.flatMap((s) => (s.hips ? [s.hips] : []))),
    spine: medianEuler(samples.flatMap((s) => (s.spine ? [s.spine] : []))),
    blendshapes,
    createdAt: now.toISOString(),
  };
}

/** `rot` minus the neutral offset, keeping any extra fields (rotationOrder). */
export function subtractOffset<T extends Euler3>(rot: T, offset: Euler3 | undefined): T {
  if (!offset) return rot;
  return { ...rot, x: rot.x - offset.x, y: rot.y - offset.y, z: rot.z - offset.z };
}

/**
 * Remaps each blendshape so the calibrated resting value reads as 0 and 1 stays
 * 1: score' = (score − base) / (1 − base). Categories without a baseline pass
 * through. Returns a new array in the same shape MediaPipe produced, so the
 * downstream mapping (faceExpressions.ts) needs no changes.
 */
export function applyBlendshapeBaseline<
  C extends { categoryName?: string; displayName?: string; score: number }
>(categories: C[], baseline: Record<string, number> | undefined): C[] {
  if (!baseline) return categories;
  return categories.map((c) => {
    const base = baseline[c.categoryName || c.displayName || ""];
    if (base === undefined || base <= 0) return c;
    return { ...c, score: clamp((c.score - base) / (1 - base), 0, 1) };
  });
}

/** Validates something read back from storage. Anything malformed is dropped
 * rather than half-applied. */
export function parseCalibration(raw: unknown): CalibrationProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.createdAt !== "string") return null;
  const euler = (v: unknown): Euler3 | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const e = v as Record<string, unknown>;
    const ok = ["x", "y", "z"].every(
      (k) => typeof e[k] === "number" && Math.abs(e[k] as number) <= MAX_ROTATION_OFFSET
    );
    return ok ? { x: e.x as number, y: e.y as number, z: e.z as number } : undefined;
  };
  const blendshapes: Record<string, number> = {};
  if (r.blendshapes && typeof r.blendshapes === "object") {
    for (const [k, v] of Object.entries(r.blendshapes as Record<string, unknown>)) {
      if (typeof v === "number" && v >= 0 && v <= MAX_BLENDSHAPE_BASELINE) blendshapes[k] = v;
    }
  }
  return {
    version: 1,
    head: euler(r.head),
    hips: euler(r.hips),
    spine: euler(r.spine),
    blendshapes,
    createdAt: r.createdAt,
  };
}
