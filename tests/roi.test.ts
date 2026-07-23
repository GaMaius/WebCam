import test from "node:test";
import assert from "node:assert/strict";
import { computeRoiRegions } from "../lib/roi.ts";

// A simple square "face" bounding box from (0.25,0.25) to (0.75,0.75) in
// normalized coordinates, on a 200x200 pixel frame.
const squareFace = [
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.25 },
  { x: 0.75, y: 0.75 },
  { x: 0.25, y: 0.75 },
];

test("computeRoiRegions places the forehead region in the upper-middle of the face box", () => {
  const { forehead } = computeRoiRegions(squareFace, 200, 200);
  const faceLeft = 0.25 * 200;
  const faceRight = 0.75 * 200;
  const faceTop = 0.25 * 200;
  const faceBottom = 0.75 * 200;

  assert.ok(forehead.x >= faceLeft && forehead.x + forehead.w <= faceRight, "forehead should stay within face width");
  assert.ok(forehead.y >= faceTop && forehead.y + forehead.h <= faceBottom, "forehead should stay within face height");
  // Should be in the upper half of the face (closer to faceTop than faceBottom).
  const foreheadCenterY = forehead.y + forehead.h / 2;
  assert.ok(foreheadCenterY < (faceTop + faceBottom) / 2, "forehead should be above the face's vertical center");
});

test("computeRoiRegions places left/right cheeks symmetrically without overlapping", () => {
  const { leftCheek, rightCheek } = computeRoiRegions(squareFace, 200, 200);
  assert.ok(leftCheek.x + leftCheek.w <= rightCheek.x, "left and right cheek regions should not overlap");

  const faceCenterX = (0.25 + 0.75) * 0.5 * 200;
  const leftCenter = leftCheek.x + leftCheek.w / 2;
  const rightCenter = rightCheek.x + rightCheek.w / 2;
  assert.ok(leftCenter < faceCenterX, "left cheek should sit left of the face center");
  assert.ok(rightCenter > faceCenterX, "right cheek should sit right of the face center");
});

test("computeRoiRegions scales with frame size", () => {
  const small = computeRoiRegions(squareFace, 100, 100);
  const large = computeRoiRegions(squareFace, 200, 200);
  assert.ok(Math.abs(large.forehead.w - small.forehead.w * 2) < 1e-6);
  assert.ok(Math.abs(large.forehead.h - small.forehead.h * 2) < 1e-6);
});

test("computeRoiRegions reports a center matching the face bounding box midpoint", () => {
  const { center } = computeRoiRegions(squareFace, 200, 200);
  assert.ok(Math.abs(center.x - 100) < 1e-6);
  assert.ok(Math.abs(center.y - 100) < 1e-6);
});
