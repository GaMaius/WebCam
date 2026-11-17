import test from "node:test";
import assert from "node:assert/strict";
import { grayWorldCorrection, classifyUndertone, classifySeason, classifyIta } from "../lib/personalColor.ts";
import { itaDegrees } from "../lib/colorSpace.ts";

test("grayWorldCorrection leaves the skin sample unchanged under neutral ambient light", () => {
  const skin = { r: 200, g: 170, b: 150 };
  const neutralAmbient = { r: 150, g: 150, b: 150 };
  const corrected = grayWorldCorrection(skin, neutralAmbient);
  assert.ok(Math.abs(corrected.r - skin.r) < 1e-6);
  assert.ok(Math.abs(corrected.g - skin.g) < 1e-6);
  assert.ok(Math.abs(corrected.b - skin.b) < 1e-6);
});

test("grayWorldCorrection cools down a skin sample captured under warm ambient light", () => {
  const skin = { r: 200, g: 170, b: 150 };
  // Warm-cast ambient light (more red/yellow, less blue) — avg=150.
  const warmAmbient = { r: 180, g: 150, b: 120 };
  const corrected = grayWorldCorrection(skin, warmAmbient);
  // Red channel should be scaled down (150/180 < 1), blue scaled up (150/120 > 1).
  assert.ok(corrected.r < skin.r, `expected red to be reduced, got ${corrected.r}`);
  assert.ok(corrected.b > skin.b, `expected blue to be boosted, got ${corrected.b}`);
  assert.ok(Math.abs(corrected.g - skin.g) < 1e-6, "green channel should be unchanged (scale=1)");
});

test("grayWorldCorrection clamps output to the valid 0-255 range", () => {
  const skin = { r: 250, g: 250, b: 250 };
  const veryDimBlueAmbient = { r: 100, g: 100, b: 10 };
  const corrected = grayWorldCorrection(skin, veryDimBlueAmbient);
  assert.ok(corrected.b <= 255);
  assert.ok(corrected.b >= 0);
});

test("classifyUndertone reads a yellow-leaning (high b*, low a*) sample as warm", () => {
  assert.equal(classifyUndertone({ L: 70, a: 5, b: 20 }), "warm");
});

test("classifyUndertone reads a pink/blue-leaning (high a*, low b*) sample as cool", () => {
  assert.equal(classifyUndertone({ L: 70, a: 20, b: 5 }), "cool");
});

test("classifyUndertone reads a balanced sample as neutral", () => {
  assert.equal(classifyUndertone({ L: 70, a: 10, b: 11 }), "neutral");
});

test("classifySeason maps warm+light to spring, warm+dark to autumn", () => {
  assert.equal(classifySeason({ L: 75, a: 5, b: 20 }, "warm"), "spring-warm");
  assert.equal(classifySeason({ L: 40, a: 5, b: 20 }, "warm"), "autumn-warm");
});

test("classifySeason maps cool+light to summer, cool+dark to winter", () => {
  assert.equal(classifySeason({ L: 75, a: 20, b: 5 }, "cool"), "summer-cool");
  assert.equal(classifySeason({ L: 40, a: 20, b: 5 }, "cool"), "winter-cool");
});

test("classifySeason resolves a neutral undertone using the raw a*/b* lean", () => {
  assert.equal(classifySeason({ L: 75, a: 10, b: 12 }, "neutral"), "spring-warm");
  assert.equal(classifySeason({ L: 75, a: 12, b: 10 }, "neutral"), "summer-cool");
});

test("itaDegrees matches the ITA formula and rises with lightness", () => {
  // ITA = atan((L-50)/b) * 180/pi. For L=70, b=20: atan(20/20)=45deg.
  assert.ok(Math.abs(itaDegrees({ L: 70, a: 10, b: 20 }) - 45) < 0.5);
  // Lighter skin (higher L) => higher ITA.
  assert.ok(itaDegrees({ L: 80, a: 10, b: 20 }) > itaDegrees({ L: 55, a: 10, b: 20 }));
});

test("classifyIta maps ITA degrees onto the standard skin-tone categories", () => {
  assert.equal(classifyIta(60), "very-light");
  assert.equal(classifyIta(48), "light");
  assert.equal(classifyIta(34), "intermediate");
  assert.equal(classifyIta(18), "tan");
  assert.equal(classifyIta(-5), "brown");
  assert.equal(classifyIta(-40), "dark");
});
