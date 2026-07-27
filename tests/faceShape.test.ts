import test from "node:test";
import assert from "node:assert/strict";
import { computeFaceGeometry, classifyFaceShape, type Point2D } from "../lib/faceShape.ts";

const EYEBROW_INDICES = [
  46, 53, 52, 65, 55, 70, 63, 105, 66, 107, 276, 283, 282, 295, 285, 300, 293, 334, 296, 336,
];

function makeLandmarks(overrides: Record<number, Point2D>): Point2D[] {
  const arr: Point2D[] = new Array(468).fill(null).map(() => ({ x: 0, y: 0 }));
  for (const idx of EYEBROW_INDICES) arr[idx] = { x: 0, y: 20 }; // default eyebrow line, overridable
  for (const [idx, pt] of Object.entries(overrides)) arr[Number(idx)] = pt;
  return arr;
}

test("computeFaceGeometry derives sensible facial thirds and length/width ratio", () => {
  const landmarks = makeLandmarks({
    10: { x: 0, y: 0 }, // forehead top
    152: { x: 0, y: 90 }, // chin
    234: { x: -40, y: 40 }, // cheek right
    454: { x: 40, y: 40 }, // cheek left
    58: { x: -35, y: 80 },
    288: { x: 35, y: 80 },
    2: { x: 0, y: 60 }, // nose base
  });
  const geometry = computeFaceGeometry(landmarks);

  // faceLength=90, cheekboneWidth=80 -> ratio 1.125
  assert.ok(Math.abs(geometry.lengthToWidth - 1.125) < 1e-6, `got ${geometry.lengthToWidth}`);

  // thirds: upper=20-0=20, mid=60-20=40, lower=90-60=30, total=90
  // normalized *3: [20/90*3, 40/90*3, 30/90*3] = [0.667, 1.333, 1.0]
  const [upper, mid, lower] = geometry.thirds;
  assert.ok(Math.abs(upper - 0.667) < 0.01, `upper: ${upper}`);
  assert.ok(Math.abs(mid - 1.333) < 0.01, `mid: ${mid}`);
  assert.ok(Math.abs(lower - 1.0) < 0.01, `lower: ${lower}`);
  assert.ok(Math.abs(upper + mid + lower - 3) < 1e-6, "thirds should sum to ~3");
});

test("classifyFaceShape identifies an oblong (long) face", () => {
  const landmarks = makeLandmarks({
    10: { x: 0, y: 0 },
    152: { x: 0, y: 160 }, // very long face
    234: { x: -40, y: 40 },
    454: { x: 40, y: 40 },
    58: { x: -35, y: 140 },
    288: { x: 35, y: 140 },
    54: { x: -38, y: 10 },
    284: { x: 38, y: 10 },
  });
  assert.equal(classifyFaceShape(landmarks), "oblong");
});

test("classifyFaceShape identifies a square (wide, flat jaw) face", () => {
  const landmarks = makeLandmarks({
    10: { x: 0, y: 0 },
    152: { x: 0, y: 100 },
    234: { x: -40, y: 40 },
    454: { x: 40, y: 40 },
    58: { x: -38, y: 85 },
    288: { x: 38, y: 85 },
    54: { x: -38, y: 10 },
    284: { x: 38, y: 10 },
  });
  assert.equal(classifyFaceShape(landmarks), "square");
});

test("classifyFaceShape identifies a round face (short, similar width, soft jaw)", () => {
  const landmarks = makeLandmarks({
    10: { x: 0, y: 0 },
    152: { x: 0, y: 85 },
    234: { x: -40, y: 35 },
    454: { x: 40, y: 35 },
    58: { x: -36, y: 75 },
    288: { x: 36, y: 75 },
    54: { x: -30, y: 10 },
    284: { x: 30, y: 10 },
  });
  assert.equal(classifyFaceShape(landmarks), "round");
});

test("classifyFaceShape identifies a heart face (wide forehead, narrow jaw)", () => {
  const landmarks = makeLandmarks({
    10: { x: 0, y: 0 },
    152: { x: 0, y: 110 },
    234: { x: -40, y: 40 },
    454: { x: 40, y: 40 },
    58: { x: -19, y: 90 },
    288: { x: 19, y: 90 },
    54: { x: -40, y: 10 },
    284: { x: 40, y: 10 },
  });
  assert.equal(classifyFaceShape(landmarks), "heart");
});

test("classifyFaceShape identifies a diamond face (narrow forehead and jaw, wide cheekbones)", () => {
  const landmarks = makeLandmarks({
    10: { x: 0, y: 0 },
    152: { x: 0, y: 110 },
    234: { x: -45, y: 40 },
    454: { x: 45, y: 40 },
    58: { x: -30, y: 90 },
    288: { x: 30, y: 90 },
    54: { x: -30, y: 10 },
    284: { x: 30, y: 10 },
  });
  assert.equal(classifyFaceShape(landmarks), "diamond");
});

test("classifyFaceShape falls back to oval for balanced proportions", () => {
  const landmarks = makeLandmarks({
    10: { x: 0, y: 0 },
    152: { x: 0, y: 104 },
    234: { x: -40, y: 40 },
    454: { x: 40, y: 40 },
    58: { x: -34, y: 88 },
    288: { x: 34, y: 88 },
    54: { x: -36.8, y: 10 },
    284: { x: 36.8, y: 10 },
  });
  assert.equal(classifyFaceShape(landmarks), "oval");
});
