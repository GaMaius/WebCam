// Finger curl direction, checked against the REAL avatar's geometry.
//
// The synthetic rig in handTracking.test.ts can only assert signs, and a sign is
// exactly the thing that was guessed wrong: an earlier version of this mapping
// hyperextended every finger, and the test in place at the time (wrist->fingertip
// distance shrinks on a curl) passed anyway, because bending backwards shortens
// that span just as much. So this file loads public/models/avatar.vrm and asserts
// the only definition of a curl that can't be fudged: the fingertip moves toward
// the side the PALM faces.

// three's ImageLoader waits on a load event and GLTFLoader hands it blob URLs,
// so stub just enough DOM for the parse to settle. Textures are irrelevant here —
// only the skeleton is measured. `node --test` gives each file its own process,
// so these globals don't leak into other tests.
const stubEl = () => {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    addEventListener(type: string, cb: () => void) {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener() {},
    style: {},
    width: 1,
    height: 1,
    set src(_v: string) {
      setTimeout(() => (listeners.load ?? []).forEach((cb) => cb()), 0);
    },
    get src() {
      return "";
    },
  };
};
(globalThis as Record<string, unknown>).document = {
  createElementNS: stubEl,
  createElement: stubEl,
};
(globalThis as Record<string, unknown>).self = globalThis;
URL.createObjectURL ??= () => "blob:stub";
URL.revokeObjectURL ??= () => {};

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import {
  applyHandRig,
  applyWorldRotation,
  solveFingerRig,
  vrmSideForHand,
} from "../lib/vrm/boneRig.ts";
import { solveWristWorldQuaternion } from "../lib/vrm/wristSolver.ts";
import type { MotionAvatar } from "../lib/vrm/motionAvatar.ts";
// @ts-expect-error - the rolled-up bundle ships no type declarations; the package
// entry re-exports from directories, which Node's ESM resolver rejects.
import * as Kalidokit from "kalidokit/dist/kalidokit.es.js";

const AVATAR_PATH = "public/models/avatar.vrm";

async function loadAvatar() {
  const buf = fs.readFileSync(AVATAR_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await new Promise<{ userData: { vrm: never } }>((resolve, reject) => {
    loader.parse(ab, "", resolve as never, reject);
  });

  const vrm = gltf.userData.vrm as {
    scene: THREE.Object3D;
    humanoid: {
      getRawBoneNode(name: string): THREE.Object3D | null;
      getNormalizedBoneNode(name: string): THREE.Object3D | null;
      update(): void;
      resetNormalizedPose(): void;
    };
  };
  assert.ok(vrm, "avatar.vrm should carry the VRM extension");

  const scene = new THREE.Scene();
  scene.add(vrm.scene);
  scene.add(
    (vrm.humanoid as unknown as { normalizedHumanBonesRoot: THREE.Object3D })
      .normalizedHumanBonesRoot
  );
  scene.updateMatrixWorld(true);

  const avatar = {
    scene: vrm.scene,
    humanoid: vrm.humanoid,
    expressionManager: null,
    extraRoots: [],
    source: "vrm",
    notes: [],
    update: () => vrm.humanoid.update(),
  } as unknown as MotionAvatar;

  const worldOf = (bone: string) => {
    const node = vrm.humanoid.getRawBoneNode(bone);
    assert.ok(node, `avatar should have a ${bone} bone`);
    node!.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(node!.matrixWorld);
  };

  return { vrm, scene, avatar, worldOf };
}

/** Fully-curled hand landmarks (MediaPipe layout: 0 wrist, 5-8 index, ...). */
function fistLandmarks(): { x: number; y: number; z: number }[] {
  const pts: { x: number; y: number; z: number }[] = [];
  const push = (x: number, y: number, z = 0) => pts.push({ x, y, z });
  const wristY = 0.8;

  push(0.5, wristY);
  // Thumb: a chain that actually TURNS, 50 degrees per joint. The previous
  // fixture stepped in a straight line, which makes every thumb joint angle
  // exactly zero — so the thumb test moved nothing and passed on a rig that
  // never folded. Generated from the angle rather than placed by eye.
  {
    const seg = 0.03;
    const step = (50 * Math.PI) / 180;
    let angle = Math.PI * 0.85;
    let x = 0.5;
    let y = wristY;
    for (let i = 1; i <= 4; i++) {
      x += Math.cos(angle) * seg;
      y += Math.sin(angle) * seg;
      push(x, y);
      angle += step;
    }
  }
  for (const x of [0.47, 0.5, 0.53, 0.56]) {
    for (let j = 1; j <= 4; j++) push(x, wristY - 0.055 * j * 0.2);
  }
  return pts;
}

test("a solved fist curls the real avatar's fingers toward the palm", async () => {
  for (const side of ["Left", "Right"] as const) {
    const { vrm, scene, avatar, worldOf } = await loadAvatar();
    // Mirrored: the user's left hand drives the avatar's right.
    const prefix = vrmSideForHand(side);

    // VRM's rest pose is a T/A-pose with BOTH palms facing down, so the palm
    // side is -Y for either hand. (Don't try to derive this from
    // `fingerDir x acrossPalm`: that cross flips sign between the two mirrored
    // hands, so one side comes out as the back of the hand. Confirmed for the
    // left by scratch/probe_vrm_axes.mjs, which measures its back-of-hand
    // normal as +Y.)
    const palmDir = new THREE.Vector3(0, -1, 0);
    // Sanity-check the rest pose really is arms-out, or "down" wouldn't mean the
    // palm at all.
    const armSpan = worldOf(`${prefix}Hand`).sub(worldOf(`${prefix}UpperArm`));
    assert.ok(
      Math.abs(armSpan.x) > Math.abs(armSpan.y) * 2,
      `${side} arm should rest horizontally (T-pose), got ${armSpan
        .toArray()
        .map((n) => n.toFixed(2))
        .join(",")}`
    );

    const before = worldOf(`${prefix}IndexDistal`);

    // Fingers only: drop the wrist entry so tilting the hand can't be mistaken
    // for a finger curl.
    const solved = solveFingerRig(fistLandmarks(), side) as Record<string, unknown>;

    for (let i = 0; i < 40; i++) {
      applyHandRig(avatar, solved as never, side, prefix);
      vrm.humanoid.update();
      scene.updateMatrixWorld(true);
    }

    const moved = worldOf(`${prefix}IndexDistal`).sub(before);
    const towardPalm = moved.dot(palmDir);

    assert.ok(
      towardPalm > 0.005,
      `${side} hand -> avatar ${prefix}: fingertip must move toward the palm (-Y), ` +
        `got ${towardPalm.toFixed(4)} — negative means it bent backwards`
    );
  }
});

test("a hand is written to the mirrored avatar side, matching the arm", async () => {
  // Kalidokit's pose solver crosses sides, so the avatar's right arm is driven by
  // the user's LEFT arm. The hand has to cross the same way or it sits on the
  // other arm — which reads as a badly wrong wrist angle rather than as a swap,
  // because both hands usually do the same thing.
  assert.equal(vrmSideForHand("Left"), "right");
  assert.equal(vrmSideForHand("Right"), "left");

  const { vrm, scene, avatar, worldOf } = await loadAvatar();
  const before = worldOf("rightIndexDistal").clone();
  const untouched = worldOf("leftIndexDistal").clone();

  const solved = solveFingerRig(fistLandmarks(), "Left") as Record<string, unknown>;
  for (let i = 0; i < 40; i++) {
    applyHandRig(avatar, solved as never, "Left", vrmSideForHand("Left"));
    vrm.humanoid.update();
    scene.updateMatrixWorld(true);
  }

  assert.ok(
    worldOf("rightIndexDistal").distanceTo(before) > 0.005,
    "the user's LEFT hand must move the avatar's RIGHT fingers"
  );
  assert.ok(
    worldOf("leftIndexDistal").distanceTo(untouched) < 1e-6,
    "and must leave the avatar's left fingers alone"
  );
});

/**
 * Raw-frame landmarks for a hand that should END UP at the given model-space
 * orientation on `vrmSide`.
 *
 * Built backwards from the wanted result on purpose. Placing index/pinky by
 * intuition doesn't work: "fingers up, palm forward" is reachable with the thumb
 * either medial or lateral — two poses 180 degrees apart in wrist roll — so a
 * hand-placed fixture silently encodes one of them and then argues with the
 * code. Instead, derive `index->pinky` from the anatomical identity that WAS
 * measured on the avatar (palm = -(fingers x across) on a left hand, +(...) on a
 * right one), then convert to raw landmarks by inverting the camera->model map
 * (which negates every axis).
 */
function landmarksFor(
  vrmSide: "left" | "right",
  fingersModel: THREE.Vector3,
  palmModel: THREE.Vector3
): { x: number; y: number; z: number }[] {
  const fingers = fingersModel.clone().normalize();
  const palm = palmModel.clone().normalize();
  // a = -(f x palm) for a right hand, +(f x palm) for a left one.
  const across = new THREE.Vector3()
    .crossVectors(fingers, palm)
    .multiplyScalar(vrmSide === "right" ? -1 : 1)
    .normalize();

  // model -> raw is the same negation as raw -> model.
  const toRaw = (v: THREE.Vector3) => v.clone().negate();
  const rawFingers = toRaw(fingers).multiplyScalar(0.2);
  const rawAcross = toRaw(across).multiplyScalar(0.1);

  const wrist = { x: 0.5, y: 0.8, z: 0 };
  const at = (v: THREE.Vector3) => ({
    x: wrist.x + v.x,
    y: wrist.y + v.y,
    z: wrist.z + v.z,
  });

  const pts: { x: number; y: number; z: number }[] = new Array(21)
    .fill(null)
    .map(() => ({ ...wrist }));
  pts[0] = { ...wrist };
  pts[9] = at(rawFingers); // middle MCP
  pts[5] = at(rawFingers.clone().multiplyScalar(0.9).sub(rawAcross.clone().multiplyScalar(0.5)));
  pts[17] = at(rawFingers.clone().multiplyScalar(0.9).add(rawAcross.clone().multiplyScalar(0.5)));
  // Extended fingers, so nothing reads as a curl.
  for (const [mcp, tip] of [[5, 8], [9, 12], [13, 16], [17, 20]]) {
    pts[mcp + 1] = at(rawFingers.clone().multiplyScalar(1.3));
    pts[mcp + 2] = at(rawFingers.clone().multiplyScalar(1.6));
    pts[tip] = at(rawFingers.clone().multiplyScalar(1.8));
  }
  return pts;
}

/** Palm toward the camera, fingers up — the pose from the screenshots. */
function palmToCameraLandmarks(twist = 0): { x: number; y: number; z: number }[] {
  const palm = new THREE.Vector3(Math.sin(twist), 0, Math.cos(twist));
  return landmarksFor("right", new THREE.Vector3(0, 1, 0), palm);
}

test("palm to camera, fingers up: the avatar's palm faces the viewer", async () => {
  // The spec case from the screenshots. The user's LEFT hand drives the avatar's
  // RIGHT hand (mirror), whose palm should end up facing +Z (at the camera) with
  // the fingers pointing +Y (up).
  const { vrm, scene, avatar, worldOf } = await loadAvatar();
  const vrmSide = vrmSideForHand("Left");
  const landmarks = palmToCameraLandmarks();

  const wristWorld = solveWristWorldQuaternion(landmarks, vrmSide);
  assert.ok(wristWorld, "the solver should produce an orientation");

  for (let i = 0; i < 60; i++) {
    applyWorldRotation(avatar, `${vrmSide}Hand`, wristWorld!, 0.5);
    vrm.humanoid.update();
    scene.updateMatrixWorld(true);
  }

  const indexProximal = worldOf(`${vrmSide}IndexProximal`);
  const fingerDir = worldOf(`${vrmSide}IndexDistal`).sub(indexProximal).normalize();
  const across = worldOf(`${vrmSide}LittleProximal`).sub(indexProximal).normalize();
  // For the avatar's RIGHT hand, fingers x (index->little) IS the palm normal.
  const palmDir = new THREE.Vector3().crossVectors(fingerDir, across).normalize();

  assert.ok(
    fingerDir.y > 0.8,
    `fingers should point up, got ${fingerDir.toArray().map((n) => n.toFixed(2)).join(",")}`
  );
  assert.ok(
    palmDir.z > 0.8,
    `palm should face the camera (+Z), got ${palmDir.toArray().map((n) => n.toFixed(2)).join(",")}`
  );
});

test("twisting the real wrist rotates the avatar's hand", async () => {
  // The regression that prompted this solver: with roll taken from the pose chain
  // the hand never rotated, because that chain only knows the wrist's POSITION.
  const vrmSide = vrmSideForHand("Left");
  const flat = solveWristWorldQuaternion(palmToCameraLandmarks(0), vrmSide);
  const twisted = solveWristWorldQuaternion(palmToCameraLandmarks(Math.PI / 2), vrmSide);
  assert.ok(flat && twisted);

  const delta = flat!.angleTo(twisted!);
  assert.ok(
    delta > 1.0,
    `a 90-degree palm twist should rotate the hand, got ${((delta * 180) / Math.PI).toFixed(1)} degrees`
  );
});

test("the avatar follows the VRM 1.0 axis convention this code assumes", async () => {
  const { worldOf } = await loadAvatar();
  // VRM 1.0 models face +Z, which puts the character's own LEFT on world +X.
  // humanoidRigger's facing/T-pose corrections depend on this.
  const left = worldOf("leftUpperArm");
  const right = worldOf("rightUpperArm");
  assert.ok(
    left.x > right.x,
    `the character's left should sit on +X: left=${left.x.toFixed(3)} right=${right.x.toFixed(3)}`
  );
});

test("a solved fist folds the thumb IN toward the knuckles, not away", () => {
  // The thumb was the one digit driven on the wrong axis, and no sign-only test
  // caught it: on Z the tip still moves "toward the palm" by the palm-normal
  // measure, it just travels away from the hand while doing so. The criterion
  // that separates a fist from a backward bend is the gap between the thumb tip
  // and the middle-finger knuckle — folding in shortens it, hyperextending
  // lengthens it.
  return (async () => {
    for (const side of ["Left", "Right"] as const) {
      const { vrm, scene, avatar, worldOf } = await loadAvatar();
      const prefix = vrmSideForHand(side);
      const gap = () =>
        worldOf(`${prefix}ThumbDistal`).distanceTo(worldOf(`${prefix}MiddleProximal`));

      const before = gap();
      const solved = solveFingerRig(fistLandmarks(), side) as Record<string, unknown>;
      for (let i = 0; i < 40; i++) {
        applyHandRig(avatar, solved as never, side, prefix);
        vrm.humanoid.update();
        scene.updateMatrixWorld(true);
      }
      const after = gap();

      assert.ok(
        after < before - 0.002,
        `${side} hand -> avatar ${prefix}: the thumb must close toward the knuckle, ` +
          `got ${before.toFixed(4)} -> ${after.toFixed(4)} (a larger gap means it bent backwards)`
      );
    }
  })();
});
