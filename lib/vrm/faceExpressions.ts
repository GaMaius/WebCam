// ARKit blendshapes (from MediaPipe FaceLandmarker) -> VRM expression weights.
//
// Why not Kalidokit for this: Kalidokit infers eyes/mouth geometrically from
// landmark distances, which is noisy and normalizes poorly across face shapes.
// FaceLandmarker can emit the 52 ARKit blendshapes directly (a dedicated head in
// the same model), which is both steadier and much closer to what VRM
// expressions were designed for. We keep the Kalidokit path as a fallback for
// when blendshapes are unavailable.
//
// Everything here is pure so the mapping is unit-testable — the sign/threshold
// mistakes in this kind of table are otherwise only visible on a real device.

/** Shape of one MediaPipe `Classifications.categories` entry. */
export interface BlendshapeCategory {
  categoryName?: string;
  displayName?: string;
  score: number;
}

/** ARKit names this mapping reads. Anything else in the 52 is ignored. */
export const USED_BLENDSHAPES = [
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "jawOpen",
  "mouthPucker",
  "mouthFunnel",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "browInnerUp",
  "browDownLeft",
  "browDownRight",
  "eyeLookUpLeft",
  "eyeLookUpRight",
  "eyeLookDownLeft",
  "eyeLookDownRight",
  "eyeLookOutLeft",
  "eyeLookInLeft",
] as const;

// A real blink rarely saturates ARKit's score, and small values are noise, so
// remap [LOW, HIGH] onto [0,1] instead of using the raw score.
const BLINK_LOW = 0.35;
const BLINK_HIGH = 0.85;
/** Below this a mouth/brow signal is treated as rest. */
const CUTOFF = 0.12;
/** `happy` also fires on smile, so damp it to avoid doubling with the vowel. */
const HAPPY_GAIN = 0.7;

function remap(v: number, low: number, high: number): number {
  if (v <= low) return 0;
  if (v >= high) return 1;
  return (v - low) / (high - low);
}

function cut(v: number): number {
  return v < CUTOFF ? 0 : v;
}

/**
 * Maps a frame of ARKit blendshape scores onto VRM expression weights.
 *
 * Vowels are mutually exclusive: ARKit's mouth shapes overlap heavily (an open
 * smile scores jawOpen AND mouthSmile), and blending several VRM visemes at once
 * turns the mouth to mush, so only the strongest vowel is emitted.
 */
export function vrmExpressionsFromBlendshapes(
  categories: BlendshapeCategory[]
): Record<string, number> {
  const s = new Map<string, number>();
  for (const c of categories) {
    const name = c.categoryName || c.displayName;
    if (name) s.set(name, c.score);
  }
  const get = (name: string) => s.get(name) ?? 0;
  const pair = (a: string, b: string) => (get(a) + get(b)) / 2;

  const out: Record<string, number> = {};

  // Eyes. ARKit is per-eye, and so is VRM, so no averaging.
  out.blinkLeft = remap(get("eyeBlinkLeft"), BLINK_LOW, BLINK_HIGH);
  out.blinkRight = remap(get("eyeBlinkRight"), BLINK_LOW, BLINK_HIGH);

  // Mouth: pick the dominant viseme.
  const vowels: Record<string, number> = {
    aa: cut(get("jawOpen")),
    ou: cut(get("mouthPucker")),
    oh: cut(get("mouthFunnel")),
    ee: cut(pair("mouthSmileLeft", "mouthSmileRight")),
    ih: cut(pair("mouthStretchLeft", "mouthStretchRight")),
  };
  let best = "";
  let bestScore = 0;
  for (const [name, value] of Object.entries(vowels)) {
    if (value > bestScore) {
      best = name;
      bestScore = value;
    }
  }
  for (const name of Object.keys(vowels)) out[name] = name === best ? bestScore : 0;

  // Emotion presets. Models that lack one just ignore it (setValue is a no-op
  // for unknown names), so it is safe to always write these.
  out.happy = cut(pair("mouthSmileLeft", "mouthSmileRight")) * HAPPY_GAIN;
  out.sad = cut(pair("mouthFrownLeft", "mouthFrownRight"));
  out.surprised = cut(get("browInnerUp"));
  out.angry = cut(pair("browDownLeft", "browDownRight"));

  // Gaze. ARKit's Out/In are relative to each eye, so the left eye looking
  // "out" and the right looking "in" both mean gazing to the viewer's left.
  const up = cut(pair("eyeLookUpLeft", "eyeLookUpRight"));
  const down = cut(pair("eyeLookDownLeft", "eyeLookDownRight"));
  out.lookUp = up > down ? up : 0;
  out.lookDown = down > up ? down : 0;
  const left = cut(get("eyeLookOutLeft"));
  const right = cut(get("eyeLookInLeft"));
  out.lookLeft = left > right ? left : 0;
  out.lookRight = right > left ? right : 0;

  return out;
}
