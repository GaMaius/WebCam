import test from "node:test";
import assert from "node:assert/strict";
import { rgbToLab, rgbToHex } from "../lib/colorSpace.ts";

function assertClose(actual: number, expected: number, tolerance: number, label: string) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: expected ~${expected}, got ${actual} (tolerance ${tolerance})`
  );
}

test("rgbToLab maps white to L=100, a=0, b=0", () => {
  const lab = rgbToLab(255, 255, 255);
  assertClose(lab.L, 100, 0.1, "L");
  assertClose(lab.a, 0, 0.1, "a");
  assertClose(lab.b, 0, 0.1, "b");
});

test("rgbToLab maps black to L=0, a=0, b=0", () => {
  const lab = rgbToLab(0, 0, 0);
  assertClose(lab.L, 0, 0.1, "L");
  assertClose(lab.a, 0, 0.1, "a");
  assertClose(lab.b, 0, 0.1, "b");
});

test("rgbToLab matches the well-known reference conversion for pure red", () => {
  // Widely cited sRGB(D65) -> CIELAB reference value for (255,0,0).
  const lab = rgbToLab(255, 0, 0);
  assertClose(lab.L, 53.24, 0.5, "L");
  assertClose(lab.a, 80.09, 0.5, "a");
  assertClose(lab.b, 67.2, 0.5, "b");
});

test("rgbToLab matches the well-known reference conversion for pure blue", () => {
  const lab = rgbToLab(0, 0, 255);
  assertClose(lab.L, 32.3, 0.5, "L");
  assertClose(lab.a, 79.19, 0.5, "a");
  assertClose(lab.b, -107.86, 0.5, "b");
});

test("rgbToLab matches the well-known reference conversion for mid-gray", () => {
  const lab = rgbToLab(128, 128, 128);
  assertClose(lab.L, 53.59, 0.3, "L");
  assertClose(lab.a, 0, 0.2, "a");
  assertClose(lab.b, 0, 0.2, "b");
});

test("rgbToHex formats and clamps correctly", () => {
  assert.equal(rgbToHex(255, 0, 0), "#ff0000");
  assert.equal(rgbToHex(0, 0, 0), "#000000");
  assert.equal(rgbToHex(-10, 300, 128.6), "#00ff81");
});
