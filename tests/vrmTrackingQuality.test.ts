import test from "node:test";
import assert from "node:assert/strict";
import { OneEuroFilter, LandmarkSmoother, SMOOTH_IMAGE } from "../lib/vrm/oneEuro.ts";
import { assignHands, type HandDetection } from "../lib/vrm/handAssign.ts";
import {
  MAX_ROTATION_OFFSET,
  MIN_CALIBRATION_FRAMES,
  applyBlendshapeBaseline,
  buildCalibration,
  parseCalibration,
  subtractOffset,
  type CalibrationSample,
} from "../lib/vrm/calibration.ts";

// ── One Euro ───────────────────────────────────────────────────────────────

/** Deterministic pseudo-noise so the test never flakes. */
function noise(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 0.02;
}

test("one euro: removes most jitter from a still signal", () => {
  const f = new OneEuroFilter(SMOOTH_IMAGE);
  let rawVar = 0;
  let outVar = 0;
  for (let i = 0; i < 300; i++) {
    const raw = 0.5 + noise(i);
    const out = f.filter(raw, i * 33.3);
    if (i > 30) {
      rawVar += (raw - 0.5) ** 2;
      outVar += (out - 0.5) ** 2;
    }
  }
  assert.ok(outVar < rawVar * 0.25, `jitter ${outVar} vs raw ${rawVar}`);
});

test("one euro: follows fast motion with little lag (unlike a fixed lerp)", () => {
  const f = new OneEuroFilter(SMOOTH_IMAGE);
  let lerped = 0;
  let euroErr = 0;
  let lerpErr = 0;
  // A hand sweeping across the frame in ~0.5 s.
  for (let i = 0; i <= 15; i++) {
    const target = i / 15;
    const out = f.filter(target, i * 33.3);
    lerped += (target - lerped) * 0.3; // the old smoothing, alone
    euroErr = Math.abs(target - out);
    lerpErr = Math.abs(target - lerped);
  }
  assert.ok(euroErr < lerpErr, `one euro lag ${euroErr} should beat lerp lag ${lerpErr}`);
});

test("landmark smoother: snaps to a re-acquired hand instead of gliding", () => {
  const s = new LandmarkSmoother(SMOOTH_IMAGE, 300);
  s.smooth([{ x: 0.1, y: 0.1, z: 0 }], 0);
  s.smooth([{ x: 0.1, y: 0.1, z: 0 }], 33);
  // Hand gone for a second, comes back on the other side.
  const back = s.smooth([{ x: 0.9, y: 0.9, z: 0 }], 1100)!;
  assert.equal(back[0].x, 0.9);
});

test("landmark smoother: keeps visibility and other fields", () => {
  const s = new LandmarkSmoother(SMOOTH_IMAGE);
  const out = s.smooth([{ x: 0.2, y: 0.3, z: 0.1, visibility: 0.77 }], 0)!;
  assert.equal(out[0].visibility, 0.77);
});

// ── Hand side assignment ───────────────────────────────────────────────────

const det = (label: string, x: number, y = 0.5): HandDetection<string> => ({
  label,
  wrist: { x, y },
  reading: `${label}@${x}`,
});

test("hands: a flipped label does not move a hand to the other arm", () => {
  // Last frame: Left hand at x=0.7, Right at x=0.3. This frame MediaPipe swaps
  // both labels but the hands barely moved.
  const out = assignHands([det("Right", 0.71), det("Left", 0.29)], {
    Left: { x: 0.7, y: 0.5 },
    Right: { x: 0.3, y: 0.5 },
  });
  assert.equal(out.Left, "Right@0.71");
  assert.equal(out.Right, "Left@0.29");
});

test("hands: both labelled the same still get one side each", () => {
  const out = assignHands([det("Left", 0.2), det("Left", 0.8)], {});
  assert.ok(out.Left && out.Right);
  assert.notEqual(out.Left, out.Right);
  // Raw frame: the larger x is the subject's left.
  assert.equal(out.Left, "Left@0.8");
});

test("hands: with no history the label decides", () => {
  const out = assignHands([det("Right", 0.8)], {});
  assert.equal(out.Right, "Right@0.8");
  assert.equal(out.Left, undefined);
});

test("hands: one hand mislabelled next to its own last position stays put", () => {
  const out = assignHands([det("Right", 0.62)], { Left: { x: 0.6, y: 0.5 } });
  assert.equal(out.Left, "Right@0.62");
});

test("hands: one hand far from any memory falls back to its label", () => {
  const out = assignHands([det("Right", 0.1)], { Left: { x: 0.9, y: 0.5 } });
  assert.equal(out.Right, "Right@0.1");
});

// ── Calibration ────────────────────────────────────────────────────────────

function samples(n: number, make: (i: number) => CalibrationSample): CalibrationSample[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

test("calibration: refuses to build from too few face frames", () => {
  assert.equal(buildCalibration(samples(MIN_CALIBRATION_FRAMES - 1, () => ({ head: { x: 0, y: 0, z: 0 } }))), null);
});

test("calibration: records the head offset of a low laptop camera", () => {
  // Looking at the screen, the head reads as pitched up by ~0.2 rad.
  const p = buildCalibration(samples(30, (i) => ({ head: { x: 0.2 + noise(i), y: 0.05, z: 0 } })))!;
  assert.ok(Math.abs(p.head!.x - 0.2) < 0.02);
  const corrected = subtractOffset({ x: 0.2, y: 0.05, z: 0, rotationOrder: "XYZ" }, p.head);
  assert.ok(Math.abs(corrected.x) < 0.02 && Math.abs(corrected.y) < 1e-9);
  assert.equal(corrected.rotationOrder, "XYZ");
});

test("calibration: a blink during the window doesn't skew the baseline (median)", () => {
  const p = buildCalibration(
    samples(30, (i) => ({
      head: { x: 0, y: 0, z: 0 },
      blendshapes: [{ categoryName: "eyeBlinkLeft", score: i === 10 || i === 11 ? 0.95 : 0.3 }],
    }))
  )!;
  assert.ok(Math.abs(p.blendshapes.eyeBlinkLeft - 0.3) < 1e-9);
});

test("calibration: never bakes in a huge offset", () => {
  const p = buildCalibration(samples(30, () => ({ head: { x: 1.4, y: -1.4, z: 0 } })))!;
  assert.equal(p.head!.x, MAX_ROTATION_OFFSET);
  assert.equal(p.head!.y, -MAX_ROTATION_OFFSET);
});

test("calibration: resting blendshape reads as 0, full stays 1", () => {
  const base = { eyeBlinkLeft: 0.3 };
  const [rest] = applyBlendshapeBaseline([{ categoryName: "eyeBlinkLeft", score: 0.3 }], base);
  const [full] = applyBlendshapeBaseline([{ categoryName: "eyeBlinkLeft", score: 1 }], base);
  const [other] = applyBlendshapeBaseline([{ categoryName: "jawOpen", score: 0.4 }], base);
  assert.equal(rest.score, 0);
  assert.equal(full.score, 1);
  assert.equal(other.score, 0.4);
});

test("calibration: round-trips through storage and rejects junk", () => {
  const p = buildCalibration(samples(30, () => ({ head: { x: 0.1, y: 0, z: 0 } })))!;
  assert.deepEqual(parseCalibration(JSON.parse(JSON.stringify(p))), p);
  assert.equal(parseCalibration({ version: 2 }), null);
  assert.equal(parseCalibration("nope"), null);
  const tampered = parseCalibration({ ...p, head: { x: 9, y: 0, z: 0 } })!;
  assert.equal(tampered.head, undefined);
});
