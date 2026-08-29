import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_HELD,
  HAND_HOLD_MS,
  LOW_FPS,
  holdLandmarks,
  planFrame,
} from "../lib/vrm/frameSchedule.ts";

test("hands run on every frame, at any frame rate", () => {
  for (const fps of [0, 60, 30, LOW_FPS, LOW_FPS - 1, 8, 2]) {
    for (let tick = 0; tick < 12; tick++) {
      assert.equal(
        planFrame(tick, fps).hands,
        true,
        `hands were skipped at tick ${tick}, fps ${fps}`
      );
    }
  }
});

test("the face also runs every frame; the body is what gives ground", () => {
  // Expressions at half rate read on a real device as the face not being tracked
  // at all, so face joined hands at full rate and the body took the cut. Don't
  // put the face back on a shared slot with the pose.
  const ticks = [...Array(12).keys()];
  assert.equal(ticks.filter((t) => planFrame(t, 30).face).length, 12, "face every frame");
  assert.equal(ticks.filter((t) => planFrame(t, 30).pose).length, 4, "body every third");
  // Still well under three full inferences a frame, which is what made everything
  // worse the first time round.
  const perFrame =
    ticks.reduce((sum, t) => {
      const p = planFrame(t, 30);
      return sum + Number(p.hands) + Number(p.face) + Number(p.pose);
    }, 0) / ticks.length;
  assert.ok(perFrame < 2.5, `budget should stay under 2.5, got ${perFrame.toFixed(2)}`);
});

test("a starving frame rate thins the slow stages, not the hands", () => {
  const ticks = [...Array(12).keys()];
  const starved = ticks.map((t) => planFrame(t, LOW_FPS - 1));
  assert.equal(starved.filter((p) => p.face).length, 6, "face halves rather than stopping");
  assert.equal(starved.filter((p) => p.pose).length, 3);
  assert.equal(starved.filter((p) => p.hands).length, 12);
  // Fewer inferences per frame than the healthy plan — that's the whole point.
  const cost = (fps: number) =>
    ticks.reduce((sum, t) => {
      const p = planFrame(t, fps);
      return sum + Number(p.hands) + Number(p.face) + Number(p.pose);
    }, 0);
  assert.ok(cost(LOW_FPS - 1) < cost(30));
});

test("negative ticks don't fall off the schedule", () => {
  // The tick counter is monotonic today, but a modulo that goes negative would
  // silently stop scheduling a stage rather than fail loudly.
  const plan = planFrame(-1, 30);
  assert.ok(plan.face || plan.pose);
});

test("a dropped detection holds the previous reading, then releases it", () => {
  const hand = [{ x: 1, y: 2, z: 3 }];
  let held = holdLandmarks(EMPTY_HELD, hand, 1000, HAND_HOLD_MS);
  assert.equal(held.value, hand);

  // Missing for less than the window: keep the old pose rather than snapping the
  // hand to rest and back, which reads as much worse tracking than being stale.
  held = holdLandmarks(held, undefined, 1000 + HAND_HOLD_MS - 1, HAND_HOLD_MS);
  assert.equal(held.value, hand);

  // Past the window: really gone.
  held = holdLandmarks(held, undefined, 1000 + HAND_HOLD_MS + 1, HAND_HOLD_MS);
  assert.equal(held.value, undefined);
});

test("the hold window measures from the last real detection, not the last frame", () => {
  // Holding relative to the previous *frame* would keep a lost hand alive
  // forever, one grace period at a time.
  const hand = [{ x: 0, y: 0, z: 0 }];
  let held = holdLandmarks(EMPTY_HELD, hand, 0, 100);
  for (const t of [40, 80, 120, 160]) {
    held = holdLandmarks(held, undefined, t, 100);
  }
  assert.equal(held.value, undefined);
});

test("a fresh detection after release starts a new hold", () => {
  const a = [{ x: 0, y: 0, z: 0 }];
  const b = [{ x: 1, y: 1, z: 1 }];
  let held = holdLandmarks(EMPTY_HELD, a, 0, 100);
  held = holdLandmarks(held, undefined, 500, 100);
  assert.equal(held.value, undefined);
  held = holdLandmarks(held, b, 600, 100);
  assert.equal(held.value, b);
  held = holdLandmarks(held, undefined, 650, 100);
  assert.equal(held.value, b);
});
