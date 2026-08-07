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
import { applyHandRig } from "../lib/vrm/boneRig.ts";
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
  for (let i = 1; i <= 4; i++) push(0.5 - 0.03 * i, wristY - 0.02 * i);
  for (const x of [0.47, 0.5, 0.53, 0.56]) {
    for (let j = 1; j <= 4; j++) push(x, wristY - 0.055 * j * 0.2);
  }
  return pts;
}

test("a solved fist curls the real avatar's fingers toward the palm", async () => {
  for (const side of ["Left", "Right"] as const) {
    const { vrm, scene, avatar, worldOf } = await loadAvatar();
    const prefix = side.toLowerCase();

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
    const solved = Kalidokit.Hand.solve(fistLandmarks(), side) as Record<string, unknown>;
    delete solved[`${side}Wrist`];

    for (let i = 0; i < 40; i++) {
      applyHandRig(avatar, solved as never, side);
      vrm.humanoid.update();
      scene.updateMatrixWorld(true);
    }

    const moved = worldOf(`${prefix}IndexDistal`).sub(before);
    const towardPalm = moved.dot(palmDir);

    assert.ok(
      towardPalm > 0.005,
      `${side} fingertip must move toward the palm (-Y), got ${towardPalm.toFixed(
        4
      )} — negative means it bent backwards`
    );
  }
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
