// Arm aiming, checked as a POSITION on the real avatar.
//
// The report this exists for: with a hand raised to the face, the avatar put its
// arm out to the side instead. Kalidokit's arm clamps make that pose unreachable,
// so armSolver aims the bones at the measured joints. A rotation-sign test can't
// tell whether that worked — the only thing that answers the complaint is where
// the hand ends up, so this asserts distance from the hand bone to the head bone.

// three's ImageLoader waits on a load event and GLTFLoader hands it blob URLs, so
// stub just enough DOM for the parse to settle. `node --test` gives each file its
// own process, so these globals don't leak.
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
import { solveArmAim, applyArmAim } from "../lib/vrm/armSolver.ts";
import type { MotionAvatar } from "../lib/vrm/motionAvatar.ts";

const AVATAR_PATH = "public/models/avatar.vrm";

async function loadAvatar() {
  const buf = fs.readFileSync(AVATAR_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await new Promise<{ userData: { vrm: never } }>((resolve, reject) => {
    loader.parse(ab, "", resolve as never, reject);
  });
  const vrm = gltf.userData.vrm as unknown as {
    scene: THREE.Object3D;
    humanoid: {
      getRawBoneNode(name: string): THREE.Object3D | null;
      getNormalizedBoneNode(name: string): THREE.Object3D | null;
      update(): void;
      normalizedHumanBonesRoot: THREE.Object3D;
    };
  };

  const scene = new THREE.Scene();
  scene.add(vrm.scene);
  scene.add(vrm.humanoid.normalizedHumanBonesRoot);
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

  const settle = (apply: () => void) => {
    for (let i = 0; i < 60; i++) {
      apply();
      vrm.humanoid.update();
      scene.updateMatrixWorld(true);
    }
  };

  return { vrm, scene, avatar, worldOf, settle };
}

/**
 * Pose world landmarks placing one arm wherever we like.
 *
 * MediaPipe world-landmark space: metres, x right in the raw frame, y DOWN, z away
 * from the camera. Only the six arm indices matter to the solver, but the array has
 * to be long enough to index them.
 */
function poseWith(
  side: "left" | "right",
  shoulder: [number, number, number],
  elbow: [number, number, number],
  wrist: [number, number, number]
) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  const idx = side === "left" ? { s: 11, e: 13, w: 15 } : { s: 12, e: 14, w: 16 };
  lm[idx.s] = { x: shoulder[0], y: shoulder[1], z: shoulder[2], visibility: 1 };
  lm[idx.e] = { x: elbow[0], y: elbow[1], z: elbow[2], visibility: 1 };
  lm[idx.w] = { x: wrist[0], y: wrist[1], z: wrist[2], visibility: 1 };
  return lm;
}

test("a hand raised to the face brings the avatar's hand to its head", async () => {
  // THE ACTUAL REPORT. Camera-space: the subject's LEFT shoulder is at raw-frame
  // +x, the elbow drops below it, and the wrist comes back UP and INWARD to beside
  // the head. Under the mirror crossing this drives the avatar's RIGHT arm.
  const { avatar, worldOf, settle } = await loadAvatar();

  const restGap = worldOf("rightHand").distanceTo(worldOf("head"));
  const lm = poseWith(
    "left",
    [0.18, -0.55, 0], // shoulder
    [0.3, -0.3, 0], // elbow: out and down
    [0.12, -0.62, -0.1] // wrist: up beside the head, slightly toward the camera
  );

  const aim = solveArmAim(lm, lm, "right");
  assert.ok(aim, "the solver should accept fully visible landmarks");
  settle(() => applyArmAim(avatar, "right", aim!));

  const gap = worldOf("rightHand").distanceTo(worldOf("head"));
  assert.ok(
    gap < restGap * 0.5,
    `the hand should come up near the head: ${restGap.toFixed(3)} at rest -> ${gap.toFixed(3)}. ` +
      `Kalidokit's clamps left this at roughly the rest distance, which is the bug.`
  );
});

test("the arm follows the wrist rather than sticking out sideways", async () => {
  // Two poses that differ ONLY in where the wrist is. If the elbow-to-wrist aim is
  // being applied, the hand tracks it; if the forearm is clamped, both land in
  // much the same place.
  const shoulder: [number, number, number] = [0.18, -0.55, 0];
  const elbow: [number, number, number] = [0.3, -0.3, 0];

  const place = async (wrist: [number, number, number]) => {
    const { avatar, worldOf, settle } = await loadAvatar();
    const lm = poseWith("left", shoulder, elbow, wrist);
    const aim = solveArmAim(lm, lm, "right");
    assert.ok(aim);
    settle(() => applyArmAim(avatar, "right", aim!));
    return worldOf("rightHand");
  };

  const up = await place([0.12, -0.62, -0.1]); // beside the head
  const down = await place([0.34, 0.02, -0.05]); // hanging down past the hip

  assert.ok(
    up.y > down.y + 0.15,
    `a raised wrist must put the hand higher than a lowered one: ` +
      `up.y=${up.y.toFixed(3)} down.y=${down.y.toFixed(3)}`
  );
});

test("the avatar's own left and right arms move to opposite sides", async () => {
  // Guards the crossing. Feeding the subject's left arm must move the avatar's
  // right; if both sides collapsed onto one arm this would fail.
  const { avatar, worldOf, settle } = await loadAvatar();
  const restLeft = worldOf("leftHand").clone();

  const lm = poseWith("left", [0.18, -0.55, 0], [0.3, -0.3, 0], [0.12, -0.62, -0.1]);
  const aim = solveArmAim(lm, lm, "right");
  settle(() => applyArmAim(avatar, "right", aim!));

  assert.ok(
    worldOf("leftHand").distanceTo(restLeft) < 1e-6,
    "driving the avatar's right arm must leave its left arm alone"
  );
  // And the moved hand really is on the avatar's right (character's right = -X).
  assert.ok(worldOf("rightHand").x < 0, "the avatar's right hand should sit at -X");
});

test("an unseen joint leaves the arm alone instead of guessing", async () => {
  // MediaPipe still emits coordinates for occluded joints; they're estimates.
  // Aiming a bone at an estimate is how an avatar starts flailing, so a
  // low-visibility joint has to abstain and let the previous pose stand.
  const lm = poseWith("left", [0.18, -0.55, 0], [0.3, -0.3, 0], [0.12, -0.62, -0.1]);
  lm[13] = { ...lm[13], visibility: 0.2 }; // elbow barely seen
  assert.equal(solveArmAim(lm, lm, "right"), null);

  // Missing world landmarks entirely: also nothing, not a throw.
  assert.equal(solveArmAim(undefined, lm, "right"), null);
  assert.equal(solveArmAim([], lm, "right"), null);
});
