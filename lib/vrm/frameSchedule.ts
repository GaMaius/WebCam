// Which MediaPipe stages run on a given frame, and how long a stage's last
// result stays valid after it stops reporting.
//
// Why this exists: tracking quality in this app is almost entirely a frame-rate
// problem. MediaPipe's VIDEO mode carries a region-of-interest from the previous
// frame, so a starved stage doesn't just update late — it loses the ROI, falls
// back to the (expensive) full detector, and gets worse, which starves it
// further.
//
// The reference the user pointed at (the gesture-synth app under
// `www.indecisiveeric.com/gesture-synth-weld.vercel.app`) tracks hands visibly
// better with the SAME model, delegate, numHands and confidences. Reading its
// bundle, the only differences are:
//   1. hands are the only model it runs, so they get every camera frame;
//   2. it skips inference when `video.currentTime` hasn't changed (we do too);
//   3. when a frame reports nothing it HOLDS the previous reading for a short
//      window instead of snapping back to neutral.
//
// (1) and (3) are what this module encodes. Hands get every frame; the two
// slower, larger-target signals (face, pose) share the remaining slot. Faces and
// torsos move slowly and are heavily smoothed downstream, so halving their rate
// costs far less than halving the hands' rate.
//
// Kept free of imports so it stays unit-testable under `node --test`.

export interface FramePlan {
  hands: boolean;
  face: boolean;
  pose: boolean;
}

/** Below this measured rate we're not keeping up; thin out the slow stages further. */
export const LOW_FPS = 18;

/**
 * Picks the stages for frame `tick` (counted in *new video frames*, not rAF
 * ticks). `fps` is the recently measured processed-frame rate; pass 0 before
 * the first measurement.
 *
 * Healthy: hands + one of face/pose → 2 inferences per frame.
 * Starving: hands + face/pose on a 4-frame cycle → 1.5 per frame.
 *
 * Hands are never skipped. Don't "balance" this by giving face or pose an equal
 * share — that's the arrangement this replaced, and it ran the hands at 15Hz.
 */
export function planFrame(tick: number, fps: number): FramePlan {
  if (fps > 0 && fps < LOW_FPS) {
    const phase = ((tick % 4) + 4) % 4;
    return { hands: true, face: phase === 0, pose: phase === 2 };
  }
  const phase = ((tick % 2) + 2) % 2;
  return { hands: true, face: phase === 0, pose: phase === 1 };
}

/** A landmark reading plus the timestamp it was last actually detected at. */
export interface HeldValue<T> {
  value?: T;
  /** performance.now() of the last real detection; 0 when never seen. */
  at: number;
}

export const EMPTY_HELD: HeldValue<never> = { at: 0 };

/** How long a hand keeps its last pose after MediaPipe stops reporting it. */
export const HAND_HOLD_MS = 250;
/** Same for the body. Longer, because losing the pose drops the arms to a rest
 * pose, which is a much bigger visual jump than a hand freezing. */
export const POSE_HOLD_MS = 400;

/**
 * Merges a new (possibly missing) reading into a held one.
 *
 * A single dropped detection is common — a blurred frame, a hand crossing the
 * edge — and reacting to it immediately makes the avatar snap to neutral and
 * back, which reads as much worse tracking than simply being one frame stale.
 * So a missing reading keeps the previous value until `holdMs` has passed since
 * the last real detection.
 */
export function holdLandmarks<T>(
  prev: HeldValue<T>,
  next: T | undefined,
  now: number,
  holdMs: number
): HeldValue<T> {
  if (next) return { value: next, at: now };
  if (prev.value && now - prev.at < holdMs) return prev;
  return { at: prev.at };
}
