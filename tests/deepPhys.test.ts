import test from "node:test";
import assert from "node:assert/strict";
import { diffNormalizeFrames, standardizeFrames } from "../lib/deepPhys.ts";
import { computeFaceCropBox } from "../lib/roi.ts";

function frame(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

test("diffNormalizeFrames returns [] for an empty clip", () => {
  assert.deepEqual(diffNormalizeFrames([]), []);
});

test("diffNormalizeFrames returns all-zero output (including padding) for a constant clip", () => {
  const frames = [frame(50, 60), frame(50, 60), frame(50, 60), frame(50, 60)];
  const result = diffNormalizeFrames(frames);
  assert.equal(result.length, frames.length);
  for (const f of result) {
    for (const v of f) assert.equal(v, 0);
  }
});

test("diffNormalizeFrames appends a trailing all-zero padding frame and preserves length", () => {
  const frames = [frame(0), frame(10), frame(0)];
  const result = diffNormalizeFrames(frames);
  assert.equal(result.length, 3);
  // Last frame is the padding frame from the reference implementation.
  assert.deepEqual(Array.from(result[2]), [0]);
});

test("diffNormalizeFrames recovers a clean +1/-1 pattern from a symmetric up-down clip", () => {
  // (10-0)/(10+0+eps) ~= 1, (0-10)/(0+10+eps) ~= -1; both diffs have the
  // same magnitude, so dividing by their own std should map them to ~+1/-1.
  const frames = [frame(0), frame(10), frame(0)];
  const result = diffNormalizeFrames(frames);
  assert.ok(Math.abs(result[0][0] - 1) < 1e-4, `expected ~1, got ${result[0][0]}`);
  assert.ok(Math.abs(result[1][0] - -1) < 1e-4, `expected ~-1, got ${result[1][0]}`);
});

test("standardizeFrames z-score normalizes a known two-frame clip exactly", () => {
  const frames = [frame(0), frame(10)];
  const result = standardizeFrames(frames);
  // mean=5, std=5 -> [(0-5)/5, (10-5)/5] = [-1, 1]
  assert.ok(Math.abs(result[0][0] - -1) < 1e-9);
  assert.ok(Math.abs(result[1][0] - 1) < 1e-9);
});

test("standardizeFrames returns all zeros (not NaN) for a constant clip", () => {
  const frames = [frame(7, 7), frame(7, 7), frame(7, 7)];
  const result = standardizeFrames(frames);
  for (const f of result) {
    for (const v of f) assert.equal(v, 0);
  }
});

test("computeFaceCropBox enlarges the tight face box by the given coefficient around its center", () => {
  // A 0.5 x 0.5 normalized face box centered in a 200x200 frame.
  const landmarks = [
    { x: 0.25, y: 0.25 },
    { x: 0.75, y: 0.25 },
    { x: 0.75, y: 0.75 },
    { x: 0.25, y: 0.75 },
  ];
  const box = computeFaceCropBox(landmarks, 200, 200, 1.5);
  // Tight box is 100x100 (0.5*200) centered at (100,100); enlarged 1.5x -> 150x150.
  assert.ok(Math.abs(box.w - 150) < 1e-6, `expected width ~150, got ${box.w}`);
  assert.ok(Math.abs(box.h - 150) < 1e-6, `expected height ~150, got ${box.h}`);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  assert.ok(Math.abs(cx - 100) < 1e-6, `expected center x ~100, got ${cx}`);
  assert.ok(Math.abs(cy - 100) < 1e-6, `expected center y ~100, got ${cy}`);
});

test("computeFaceCropBox clamps to frame bounds when the enlarged box would overflow", () => {
  // Face box touching the top-left corner — enlarging around its center
  // would normally push the crop off-frame on the top/left.
  const landmarks = [
    { x: 0.0, y: 0.0 },
    { x: 0.2, y: 0.0 },
    { x: 0.2, y: 0.2 },
    { x: 0.0, y: 0.2 },
  ];
  const box = computeFaceCropBox(landmarks, 200, 200, 1.5);
  assert.ok(box.x >= 0, `expected x >= 0, got ${box.x}`);
  assert.ok(box.y >= 0, `expected y >= 0, got ${box.y}`);
  assert.ok(box.x + box.w <= 200 + 1e-6, `expected box to stay within frame width`);
  assert.ok(box.y + box.h <= 200 + 1e-6, `expected box to stay within frame height`);
});
