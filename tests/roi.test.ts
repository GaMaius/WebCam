import test from "node:test";
import assert from "node:assert/strict";
import { computeRoiRegions, isSkinPixel, isRegionUsableSkin } from "../lib/roi.ts";

// A simple square "face" bounding box from (0.25,0.25) to (0.75,0.75) in
// normalized coordinates, on a 200x200 pixel frame.
const squareFace = [
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.25 },
  { x: 0.75, y: 0.75 },
  { x: 0.25, y: 0.75 },
];

/** Landmarks spanning an arbitrary normalized box, for the neck tests below. */
function faceBox(x: number, y: number, w: number, h: number) {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

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

test("isSkinPixel accepts typical skin tones and rejects non-skin colors", () => {
  // Representative skin RGBs across a range of tones.
  assert.ok(isSkinPixel(230, 190, 170), "light skin should classify as skin");
  assert.ok(isSkinPixel(200, 150, 120), "medium skin should classify as skin");
  assert.ok(isSkinPixel(140, 95, 70), "deep skin should classify as skin");
  // Non-skin: eyebrow/hair (near-black), background greens/blues, pure white.
  assert.ok(!isSkinPixel(20, 20, 20), "near-black (brow/hair) should be rejected");
  assert.ok(!isSkinPixel(40, 120, 60), "green background should be rejected");
  assert.ok(!isSkinPixel(60, 90, 200), "blue should be rejected");
});

test("the neck region sits below the chin, not on the face", () => {
  // The carotid region is genuinely one of the stronger rPPG sites, but it lives
  // OUTSIDE the face landmark box, so it's the one region that can legitimately
  // fall out of frame. Getting it wrong by placing it inside the box would
  // silently double-count the chin instead.
  const landmarks = faceBox(0.3, 0.2, 0.4, 0.5); // x,y,w,h in normalized space
  const regions = computeRoiRegions(landmarks, 640, 480);
  const faceBottom = (0.2 + 0.5) * 480;

  assert.ok(
    regions.neck.y >= faceBottom,
    `neck should start at or below the chin (${faceBottom}), got ${regions.neck.y}`
  );
  // Horizontally centred on the throat, inside the face's own width.
  const neckCenterX = regions.neck.x + regions.neck.w / 2;
  assert.ok(Math.abs(neckCenterX - regions.center.x) < 8, "neck should be centred under the face");
  assert.ok(regions.neck.w > 0 && regions.neck.h > 0);
});

test("a neck region off the bottom of the frame is rejected", () => {
  // A tight framing (face filling the shot) puts the neck out of view. Averaging
  // whatever pixels the clamped rectangle lands on would inject noise, so the
  // gate has to reject it — this is what makes "the neck is used when visible"
  // true rather than aspirational.
  const landmarks = faceBox(0.3, 0.55, 0.4, 0.44);
  const regions = computeRoiRegions(landmarks, 640, 480);
  const perfectSkin = { r: 180, g: 130, b: 110, skinRatio: 1 };
  assert.equal(
    isRegionUsableSkin(regions.neck, perfectSkin, 640, 480),
    false,
    "a neck box extending past the frame must be rejected even with perfect skin"
  );

  // And in a roomier framing it is accepted.
  const roomy = computeRoiRegions(faceBox(0.35, 0.1, 0.3, 0.4), 640, 480);
  assert.equal(isRegionUsableSkin(roomy.neck, perfectSkin, 640, 480), true);
  // ...but not when the pixels aren't skin (a collar, a beard, shadow).
  assert.equal(
    isRegionUsableSkin(roomy.neck, { r: 40, g: 40, b: 90, skinRatio: 0.1 }, 640, 480),
    false
  );
});
