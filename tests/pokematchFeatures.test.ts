import test from "node:test";
import assert from "node:assert/strict";
import {
  describeFaceFeatures,
  extractFaceFeatures,
  sampleDisc,
} from "../lib/pokematch/faceFeatures.ts";

// PokéMatch's judge is text-only, so these descriptors ARE the input. A ratio
// that silently depends on the frame's aspect ratio would make the same person
// read as a different face on a 16:9 webcam vs a 4:3 one — which is exactly
// the kind of instability the app is trying to get away from.

/** Builds a full 468-point mesh from a physical (square-pixel) face layout,
 * then divides back into MediaPipe's per-axis normalized space for a frame of
 * `frameW` x `frameH`. */
function meshFor(frameW: number, frameH: number, overrides: Record<number, [number, number]>) {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  for (const [idx, [px, py]] of Object.entries(overrides)) {
    pts[Number(idx)] = { x: px / frameW, y: py / frameH };
  }
  return pts;
}

/** A neutral face laid out in pixels, centered in a 640-wide frame. */
function faceLayout(cx: number, cy: number) {
  return {
    10: [cx, cy - 100], // forehead top
    151: [cx, cy - 80], // mid forehead
    152: [cx, cy + 100], // chin
    234: [cx - 70, cy], // right cheek
    454: [cx + 70, cy], // left cheek
    58: [cx - 55, cy + 55], // right jaw
    288: [cx + 55, cy + 55], // left jaw
    54: [cx - 60, cy - 70], // right temple
    284: [cx + 60, cy - 70], // left temple
    2: [cx, cy + 30], // nose base
    // eyes
    33: [cx - 55, cy - 20],
    133: [cx - 25, cy - 20],
    159: [cx - 40, cy - 27],
    145: [cx - 40, cy - 13],
    362: [cx + 25, cy - 20],
    263: [cx + 55, cy - 20],
    386: [cx + 40, cy - 27],
    374: [cx + 40, cy - 13],
    // brows
    105: [cx - 40, cy - 45],
    334: [cx + 40, cy - 45],
    107: [cx - 20, cy - 42],
    46: [cx - 58, cy - 48],
    // nose
    129: [cx - 18, cy + 28],
    358: [cx + 18, cy + 28],
    1: [cx, cy + 20],
    // mouth
    61: [cx - 32, cy + 62],
    291: [cx + 32, cy + 62],
    0: [cx, cy + 52],
    17: [cx, cy + 74],
    13: [cx, cy + 62],
    // cheek pads
    50: [cx - 45, cy + 15],
    280: [cx + 45, cy + 15],
  } as Record<number, [number, number]>;
}

function flatPixels(w: number, h: number, rgb: [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

test("geometry is aspect-corrected: the same face reads the same on 4:3 and 16:9", () => {
  const layout = faceLayout(320, 240);
  const a = extractFaceFeatures(meshFor(640, 480, layout), flatPixels(640, 480, [200, 170, 150]), 640, 480);
  const b = extractFaceFeatures(meshFor(640, 360, layout), flatPixels(640, 360, [200, 170, 150]), 640, 360);
  assert.ok(a && b);

  for (const key of [
    "lengthToWidth",
    "jawToCheek",
    "foreheadToCheek",
    "eyeOpenness",
    "eyeWidthRatio",
    "noseWidthRatio",
    "mouthWidthRatio",
    "lipFullness",
  ] as const) {
    assert.ok(
      Math.abs(a[key] - b[key]) < 0.02,
      `${key} moved with the frame aspect ratio: ${a[key]} vs ${b[key]}`
    );
  }
  assert.equal(a.shape, b.shape);
});

test("wider eyes and a squarer jaw actually move the numbers", () => {
  const base = faceLayout(320, 240);
  const wideEyes = { ...base, 159: [280, 205], 145: [280, 233], 386: [360, 205], 374: [360, 233] } as Record<
    number,
    [number, number]
  >;
  const narrowJaw = { ...base, 58: [290, 295], 288: [350, 295] } as Record<number, [number, number]>;

  const pixels = flatPixels(640, 480, [200, 170, 150]);
  const b = extractFaceFeatures(meshFor(640, 480, base), pixels, 640, 480)!;
  const w = extractFaceFeatures(meshFor(640, 480, wideEyes), pixels, 640, 480)!;
  const n = extractFaceFeatures(meshFor(640, 480, narrowJaw), pixels, 640, 480)!;

  assert.ok(w.eyeOpenness > b.eyeOpenness, "taller lid gap should raise eye openness");
  assert.ok(n.jawToCheek < b.jawToCheek, "a narrower jaw should lower jawToCheek");
});

test("skin sampling reads the cheek color, not the background", () => {
  const w = 640;
  const h = 480;
  const data = flatPixels(w, h, [20, 20, 20]); // dark background
  // Paint a light skin patch over the whole face region.
  for (let y = 120; y < 360; y++) {
    for (let x = 230; x < 410; x++) {
      const i = (y * w + x) * 4;
      data[i] = 226;
      data[i + 1] = 184;
      data[i + 2] = 160;
    }
  }
  const f = extractFaceFeatures(meshFor(w, h, faceLayout(320, 240)), data, w, h)!;
  assert.match(f.skin.hex, /^#e2b8a0$/i);
  assert.ok(["very-light", "light", "intermediate"].includes(f.skin.itaCategory), f.skin.itaCategory);
});

test("sampleDisc averages only inside the frame", () => {
  const data = flatPixels(4, 4, [100, 100, 100]);
  // Top-left pixel is white; sampling the corner must not read out of bounds.
  data[0] = 255;
  data[1] = 255;
  data[2] = 255;
  const s = sampleDisc(data, 4, 4, 0, 0, 1);
  assert.ok(s.r > 100 && s.r < 255, `expected a blend, got ${s.r}`);
  assert.ok(Number.isFinite(s.g) && Number.isFinite(s.b));
});

test("the description names every measurement the judge is asked to cite", () => {
  const f = extractFaceFeatures(
    meshFor(640, 480, faceLayout(320, 240)),
    flatPixels(640, 480, [200, 170, 150]),
    640,
    480
  )!;
  const text = describeFaceFeatures(f);
  // English labels: the descriptor is sent to a model whose tokenizer costs
  // ~2.7 tokens per Hangul character, so the Korean version cost 488 tokens
  // against 117 for this one — the difference between two scans fitting in a
  // minute's budget and one. See describeFaceFeatures.
  for (const label of ["face", "eye width", "eye tilt", "brow", "nose width", "lips", "skin", "hair"]) {
    assert.ok(text.includes(label), `description is missing "${label}"`);
  }
  assert.ok(!/[가-힣]/.test(text), "Korean leaked back into the descriptor");
  assert.ok(text.length > 200, "description is too thin to reason from");
});

test("a short landmark array is rejected rather than measured wrong", () => {
  assert.equal(extractFaceFeatures([{ x: 0.5, y: 0.5 }], flatPixels(8, 8, [0, 0, 0]), 8, 8), null);
});
