import test from "node:test";
import assert from "node:assert/strict";
import type { Rot } from "../lib/vrm/boneRig.ts";
import {
  boostCurl,
  jointFlexion,
  solveFingerRig,
  FINGER_CURL_GAIN,
} from "../lib/vrm/boneRig.ts";
// Kalidokit's package entry re-exports from directories, which Node's ESM
// resolver rejects; reach for the rolled-up bundle it also ships (test-only).
// Only used to pin down WHY its hand solver isn't the one driving the fingers.
// @ts-expect-error - the deep bundle path ships no type declarations
import * as Kalidokit from "kalidokit/dist/kalidokit.es.js";

// These fixtures are GENERATED from the joint angles they're supposed to
// represent, not placed by eye. Hand-placing a fist is how a previous round of
// this got a passing test for a hand that bent backwards on a real device: an
// intuited pose smuggles in an assumption, and the assertion then locks it in.
// Here the ground truth is the input, so a fixture can't quietly disagree with it.

const DEG = Math.PI / 180;

interface P {
  x: number;
  y: number;
  z: number;
}

const cross = (a: P, b: P): P => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const unit = (v: P): P => {
  const len = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
};
/** Rodrigues rotation of `v` about the unit axis `k`. */
function rotateAbout(v: P, k: P, angle: number): P {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const dot = k.x * v.x + k.y * v.y + k.z * v.z;
  return {
    x: v.x * c + kv.x * s + k.x * dot * (1 - c),
    y: v.y * c + kv.y * s + k.y * dot * (1 - c),
    z: v.z * c + kv.z * s + k.z * dot * (1 - c),
  };
}

/**
 * One digit as metric geometry: held up in front of the camera and curling
 * towards the viewer, which is the pose a fist makes.
 *
 * Camera at the origin looking down +Z, image y running down, so "up" is -Y. The
 * first segment is the palm (wrist -> knuckle) and doesn't flex, so the three
 * flexions land on the MCP/PIP/DIP joints — the three angles Kalidokit measures.
 *
 * Each digit curls in ITS OWN plane, spanned by its splayed palm direction and
 * the view axis, rather than about a shared world axis. Curling every digit about
 * +X instead looked equivalent but wasn't: a splayed digit's palm segment is
 * tilted out of the Y/Z plane, so a shared axis adds a constant out-of-plane
 * bend, and a fixture built for "3 degrees of flexion" measured 11. The angles
 * this produces are the angles asked for.
 */
function digit(flexDeg: [number, number, number], xOffset: number, wrist: P): P[] {
  const lengths = [0.08, 0.045, 0.03, 0.022];
  const flex = [0, ...flexDeg];
  const palmDir = unit({ x: xOffset, y: -lengths[0], z: 0 });
  // Curl towards the camera (-Z), the foreshortened direction that breaks.
  const curlAxis = unit(cross(palmDir, { x: 0, y: 0, z: -1 }));
  const pts: P[] = [];
  let cursor = { ...wrist };
  let angle = 0;
  for (let i = 0; i < lengths.length; i++) {
    angle += flex[i] * DEG;
    const dir = rotateAbout(palmDir, curlAxis, angle);
    cursor = {
      x: cursor.x + dir.x * lengths[i],
      y: cursor.y + dir.y * lengths[i],
      z: cursor.z + dir.z * lengths[i],
    };
    pts.push({ ...cursor });
  }
  return pts; // knuckle, joint, joint, tip
}

/** A full 21-point hand in metric space (HandLandmarker's worldLandmarks). */
function metricHand(flexDeg: [number, number, number]): P[] {
  const wrist: P = { x: 0, y: 0.05, z: 0.5 };
  // MediaPipe order: 0 wrist, 1-4 thumb, 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky.
  const spread = [-0.035, -0.015, 0.005, 0.022, 0.038];
  return [wrist, ...spread.flatMap((x) => digit(flexDeg, x, wrist))];
}

// A typical webcam frame for the 640x480 capture this page asks for.
const W = 640;
const H = 480;
const F = 600;

/**
 * Metric hand -> MediaPipe-style normalized landmarks.
 *
 * `depthScale` is how much of the true depth range survives. MediaPipe documents
 * normalized z as relative to the wrist and "roughly the same scale as x", but in
 * practice the channel is heavily flattened, so this is the dial that models the
 * real failure. Note x divides by the width and y by the height: that alone makes
 * the space anisotropic on any non-square frame.
 */
function toNormalized(pts: P[], depthScale: number): P[] {
  const wristZ = pts[0].z;
  return pts.map((p) => ({
    x: (F * (p.x / p.z) + W / 2) / W,
    y: (F * (p.y / p.z) + H / 2) / H,
    z: ((p.z - wristZ) * (F / wristZ) * depthScale) / W,
  }));
}

/** Largest absolute curl the app's solver reports for the index finger, in radians. */
function indexCurl(landmarks: P[], side: "Left" | "Right"): number {
  const rig = solveFingerRig(landmarks, side);
  return Math.max(
    ...(["Proximal", "Intermediate", "Distal"] as const).map((j) =>
      Math.abs(rig[`${side}Index${j}`].z)
    )
  );
}

test("a fist read from metric landmarks curls the fingers hard", () => {
  for (const side of ["Left", "Right"] as const) {
    const curl = indexCurl(metricHand([90, 100, 70]), side);
    // 90 degrees of flexion is 1.57 rad; anything near zero is an open hand.
    assert.ok(curl > 1.2, `${side} fist should curl hard, got ${curl.toFixed(3)} rad`);
  }
});

/** Per-joint flexion the solver measures for the index finger, in degrees. */
function indexFlexion(landmarks: P[]): number[] {
  return [
    [0, 5, 6],
    [5, 6, 7],
    [6, 7, 8],
  ].map(([a, b, c]) => jointFlexion(landmarks[a], landmarks[b], landmarks[c]) / DEG);
}

test("metric landmarks recover the real joint angles; normalized ones don't", () => {
  // THE FIRST BUG, stated as accuracy rather than magnitude. A fist pointed at the
  // camera puts the chain wrist->knuckle->joint->tip almost entirely along the view
  // axis. Measure it in metric space and the angles come back; measure it in
  // normalized image space, where x divides by the frame width but y by its height
  // and z is a weak relative depth, and they don't.
  const truth = [90, 100, 70];
  const metric = indexFlexion(metricHand(truth as [number, number, number]));
  metric.forEach((got, i) => {
    assert.ok(
      Math.abs(got - truth[i]) < 2,
      `metric joint ${i} should read ${truth[i]} deg, got ${got.toFixed(1)}`
    );
  });

  // Depth-free, the projected chain is nearly collinear, so the angles are junk in
  // both directions: some joints read as straight, others as bent double. On device
  // this showed up as a fist that wouldn't close.
  const flat = indexFlexion(toNormalized(metricHand(truth as [number, number, number]), 0));
  const flatError = Math.max(...flat.map((got, i) => Math.abs(got - truth[i])));
  assert.ok(
    flatError > 40,
    `depth-free normalized angles should be badly wrong, got ${flat
      .map((d) => d.toFixed(0))
      .join("/")} vs ${truth.join("/")} deg`
  );

  // And a quarter of the depth range surviving isn't enough either, so this is not
  // just an all-or-nothing edge case.
  const partial = indexFlexion(toNormalized(metricHand(truth as [number, number, number]), 0.25));
  const partialError = Math.max(...partial.map((got, i) => Math.abs(got - truth[i])));
  assert.ok(
    partialError > 15,
    `flattened depth should still be well off, got ${partial
      .map((d) => d.toFixed(0))
      .join("/")} vs ${truth.join("/")} deg`
  );
});

test("metric landmarks track the curl across the range, not just at the extremes", () => {
  const closed = indexCurl(metricHand([90, 100, 70]), "Right");
  const half = indexCurl(metricHand([45, 50, 35]), "Right");
  const open = indexCurl(metricHand([3, 3, 3]), "Right");
  assert.ok(open < 0.1, `an open hand must stay open, got ${open.toFixed(3)} rad`);
  assert.ok(half > open && half < closed, `half-closed should sit between: ${half.toFixed(3)}`);
});

test("an open hand read from normalized landmarks is open too — so the bug is one-sided", () => {
  // Worth pinning down: the projection error never invents curl, it only loses it.
  // That's why the symptom was always "doesn't bend enough" and never "bends on
  // its own", and why boosting the curl is a safe direction to correct in.
  const open = toNormalized(metricHand([3, 3, 3]), 0.25);
  assert.ok(indexCurl(open, "Right") < 0.1);
});

test("the thumb goes through the same solver as the other four digits", () => {
  // The thumb used to be a separate path (Kalidokit's, then a hand-written one)
  // and it was the joint the user called out as worst. It's now just another digit
  // under one formula, so the only thumb-specific behavior left is its damping.
  // The thumb is driven on Y, the fingers on Z — measured, see solveFingerRig.
  const driven = (rig: Record<string, Rot>, key: string) =>
    Math.abs(key.includes("Thumb") ? rig[key].y : rig[key].z);
  const closed = solveFingerRig(metricHand([90, 100, 70]), "Right");
  const open = solveFingerRig(metricHand([3, 3, 3]), "Right");

  assert.ok(
    driven(closed, "RightThumbProximal") > 0.5,
    `a closed thumb should bend, got ${driven(closed, "RightThumbProximal").toFixed(3)}`
  );
  assert.ok(
    driven(open, "RightThumbProximal") < 0.1,
    `an open thumb should stay straight, got ${driven(open, "RightThumbProximal").toFixed(3)}`
  );
  // Damped relative to a finger at the same real angle, which is the one thing
  // that still sets the thumb apart beyond its axis.
  assert.ok(
    driven(closed, "RightThumbIntermediate") < driven(closed, "RightIndexIntermediate"),
    "the thumb's range should stay damped below a finger's"
  );
  // Signs mirror per side, so the crossing to the avatar's other hand lines up.
  // Note the thumb's pattern is the OPPOSITE of the fingers' — an anatomical right
  // hand drives the avatar's LEFT thumb, which folds on +Y.
  const closedLeft = solveFingerRig(metricHand([90, 100, 70]), "Left");
  assert.ok(closed["RightThumbProximal"].y > 0, "anatomical-right thumb drives +Y");
  assert.ok(closedLeft["LeftThumbProximal"].y < 0, "anatomical-left thumb drives -Y");
  // Never on Z, the axis that folded it backwards.
  assert.equal(closed["RightThumbProximal"].z, 0);
  assert.equal(closedLeft["LeftThumbProximal"].z, 0);
});

test("curl keeps increasing past a right angle instead of reversing", () => {
  // THE OTHER BUG. Kalidokit's joint measure folds anything past 90 degrees back
  // down — 100 reads as 80, 120 as 60 — so the harder a fist squeezed, the
  // straighter the avatar's fingers became. A tight fist's middle joints reach
  // 100-120 degrees, and the thumb folds furthest of all, which is why the thumb
  // looked worst of everything.
  const flexAt = (deg: number) => {
    const pts = metricHand([deg, deg, deg]);
    // The PIP joint: landmarks 5 (knuckle), 6, 7.
    return jointFlexion(pts[5], pts[6], pts[7]);
  };
  const ladder = [30, 60, 90, 110, 130].map(flexAt);
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(
      ladder[i] > ladder[i - 1],
      `flexion must keep rising: ${ladder.map((r) => (r / DEG).toFixed(0)).join(" -> ")} deg`
    );
  }
  // And it reports the real angle, not a folded one.
  assert.ok(Math.abs(flexAt(120) / DEG - 120) < 1, `120 deg should read as 120, got ${(flexAt(120) / DEG).toFixed(1)}`);

  // For contrast, the measure this replaced peaks at 90 and comes back down.
  const kalidokit = (deg: number) => {
    const rig = Kalidokit.Hand.solve(metricHand([deg, deg, deg]), "Right") as Record<
      string,
      { z: number }
    >;
    return Math.abs(rig["RightIndexIntermediate"].z);
  };
  assert.ok(
    kalidokit(130) < kalidokit(90),
    "documents the fold that made a tighter fist look more open"
  );
});

test("the curl boost scales without ever flipping a finger backwards", () => {
  // A finger bends towards the palm only, which is why the valid range is a half
  // range: [-PI, 0] for a right hand, [0, PI] for a left. Gain must not push a
  // joint through zero into a backwards bend, and must not overshoot PI.
  assert.equal(boostCurl({ x: 0, y: 0, z: -1 }, "Right", 1.5).z, -1.5);
  assert.equal(boostCurl({ x: 0, y: 0, z: 1 }, "Left", 1.5).z, 1.5);
  assert.equal(boostCurl({ x: 0, y: 0, z: -3 }, "Right", 2).z, -Math.PI);
  assert.equal(boostCurl({ x: 0, y: 0, z: 3 }, "Left", 2).z, Math.PI);
  // Wrong-signed input (shouldn't happen, but the clamp is the guard) is pinned
  // to the neutral end rather than becoming a backwards bend.
  assert.equal(boostCurl({ x: 0, y: 0, z: 0.5 }, "Right", 1.5).z, 0);
  assert.equal(boostCurl({ x: 0, y: 0, z: -0.5 }, "Left", 1.5).z, 0);
  // x/y ride along untouched — only the curl axis is scaled.
  const boosted = boostCurl({ x: 0.2, y: -0.3, z: -1 }, "Right");
  assert.equal(boosted.x, 0.2);
  assert.equal(boosted.y, -0.3);
  assert.ok(FINGER_CURL_GAIN >= 1, "the gain should never reduce the curl");
});
