// Keeps each detected hand on the same side from frame to frame.
//
// MediaPipe's handedness label is a per-frame classification, and it flips:
// when a hand turns edge-on, when the hands get close, or simply for a frame on
// a blurred image. It also sometimes labels BOTH hands the same. The old code
// trusted the label verbatim, so a single misclassified frame moved a hand onto
// the other arm for a frame and back — the avatar's hands visibly swapped. The
// hold logic made it worse, because the side that lost its hand kept a stale
// copy while the other side got the wrong one.
//
// Fix: the label decides only when there is nothing better. When we already
// know where each hand was, a detection goes to the side whose last wrist it is
// nearest — hands cannot teleport across the frame between two video frames,
// but labels can.
//
// Pure and import-free so it runs under `node --test`.

export type Side = "Left" | "Right";

export interface HandDetection<T> {
  /** MediaPipe's handedness label for this detection, if any. */
  label?: string;
  /** Normalized wrist position (landmark 0). */
  wrist: { x: number; y: number };
  reading: T;
}

export interface LastWrists {
  Left?: { x: number; y: number };
  Right?: { x: number; y: number };
}

/** Beyond this (in frame widths) a previous position is too far to be the same
 * hand, so continuity gives no evidence and the label decides. */
export const MAX_CONTINUITY_DIST = 0.25;

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function labelSide(label: string | undefined): Side | undefined {
  return label === "Left" || label === "Right" ? label : undefined;
}

/**
 * Assigns up to two detections to Left/Right.
 *
 * - Two hands, both previous wrists known: pick whichever pairing has the
 *   smaller total travel. Labels are ignored — they are the noisy signal here.
 * - Two hands, labels disagree with each other (both "Left"): fall back to the
 *   previous positions if we have any, otherwise to screen order (in the
 *   unmirrored camera frame the subject's right hand is on the image left).
 * - One hand: if it is clearly near one side's last wrist, it stays there;
 *   otherwise its label decides.
 */
export function assignHands<T>(
  detections: HandDetection<T>[],
  last: LastWrists
): { Left?: T; Right?: T; wrists: LastWrists } {
  const dets = detections.slice(0, 2);
  const out: { Left?: T; Right?: T; wrists: LastWrists } = { wrists: {} };
  const put = (side: Side, d: HandDetection<T>) => {
    out[side] = d.reading;
    out.wrists[side] = d.wrist;
  };

  if (dets.length === 2) {
    const [a, b] = dets;
    if (last.Left && last.Right) {
      const keep = dist(a.wrist, last.Left) + dist(b.wrist, last.Right);
      const swap = dist(a.wrist, last.Right) + dist(b.wrist, last.Left);
      // Only trust continuity if the better pairing is actually plausible.
      if (Math.min(keep, swap) < MAX_CONTINUITY_DIST * 2) {
        if (keep <= swap) {
          put("Left", a);
          put("Right", b);
        } else {
          put("Left", b);
          put("Right", a);
        }
        return out;
      }
    }
    const la = labelSide(a.label);
    const lb = labelSide(b.label);
    if (la && lb && la !== lb) {
      put(la, a);
      put(lb, b);
      return out;
    }
    // Labels missing or identical. MediaPipe's "Left" is the hand on the image
    // right in the raw (unmirrored) frame, so the larger x is "Left".
    const [onRight, onLeft] = a.wrist.x >= b.wrist.x ? [a, b] : [b, a];
    put("Left", onRight);
    put("Right", onLeft);
    return out;
  }

  if (dets.length === 1) {
    const d = dets[0];
    const dl = last.Left ? dist(d.wrist, last.Left) : Infinity;
    const dr = last.Right ? dist(d.wrist, last.Right) : Infinity;
    const nearest: Side | undefined =
      Math.min(dl, dr) < MAX_CONTINUITY_DIST ? (dl <= dr ? "Left" : "Right") : undefined;
    // Continuity wins only when it is decisive: the hand is near one side's
    // last position and clearly nearer than to the other's.
    if (nearest && (Math.max(dl, dr) === Infinity || Math.abs(dl - dr) > 0.05)) {
      put(nearest, d);
      return out;
    }
    const side = labelSide(d.label) ?? nearest;
    if (side) put(side, d);
    return out;
  }

  return out;
}
