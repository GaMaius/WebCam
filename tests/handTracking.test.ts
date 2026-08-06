import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildHumanoidRig, classifyBoneName } from "../lib/vrm/humanoidRigger.ts";
import {
  applyHandRig,
  resolvePoseGates,
  withLandmarkVisibility,
} from "../lib/vrm/boneRig.ts";
import { vrmExpressionsFromBlendshapes } from "../lib/vrm/faceExpressions.ts";
import type { MotionAvatar } from "../lib/vrm/motionAvatar.ts";
// Kalidokit's package entry re-exports from directories, which Node's ESM
// resolver rejects (bundlers are fine with it), so reach for the rolled-up ESM
// bundle it also ships. This is test-only; app code imports "kalidokit".
// @ts-expect-error - the deep bundle path ships no type declarations
import * as Kalidokit from "kalidokit/dist/kalidokit.es.js";

test("finger bones map with VRM 1.0's shifted thumb chain", () => {
  // Kalidokit and most rigs number joints 1..3 from the palm; VRM 1.0 calls the
  // thumb's three joints Metacarpal/Proximal/Distal, so a naive name match puts
  // every thumb rotation one joint too far out.
  assert.equal(classifyBoneName("mixamorigLeftHandThumb1"), "leftThumbMetacarpal");
  assert.equal(classifyBoneName("mixamorigLeftHandThumb2"), "leftThumbProximal");
  assert.equal(classifyBoneName("mixamorigLeftHandThumb3"), "leftThumbDistal");

  assert.equal(classifyBoneName("mixamorigLeftHandIndex1"), "leftIndexProximal");
  assert.equal(classifyBoneName("mixamorigLeftHandIndex2"), "leftIndexIntermediate");
  assert.equal(classifyBoneName("mixamorigRightHandIndex3"), "rightIndexDistal");

  // VRM calls the pinky "little".
  assert.equal(classifyBoneName("mixamorigRightHandPinky1"), "rightLittleProximal");
  assert.equal(classifyBoneName("J_Bip_L_Little2"), "leftLittleIntermediate");
  assert.equal(classifyBoneName("f_index.01.L"), "leftIndexProximal");

  // The hand itself must still resolve even though Mixamo finger names contain
  // "Hand" — the finger check runs first, so this is the ordering guard.
  assert.equal(classifyBoneName("mixamorigLeftHand"), "leftHand");
});

/** Minimal upper-body rig with a full left index + thumb chain, in metres. */
function buildRigWithFingers(): THREE.Object3D {
  const root = new THREE.Object3D();
  const bone = (name: string, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const b = new THREE.Bone();
    b.name = `mixamorig${name}`;
    b.position.set(x, y, z);
    parent.add(b);
    return b;
  };

  const hips = bone("Hips", root, 0, 1.0, 0);
  const spine = bone("Spine", hips, 0, 0.1, 0);
  const spine1 = bone("Spine1", spine, 0, 0.1, 0);
  const neck = bone("Neck", spine1, 0, 0.1, 0);
  bone("Head", neck, 0, 0.1, 0);

  for (const side of ["Left", "Right"] as const) {
    const f = side === "Left" ? -1 : 1;
    const shoulder = bone(`${side}Shoulder`, spine1, 0.05 * f, 0.08, 0);
    const upper = bone(`${side}Arm`, shoulder, 0.05 * f, 0, 0);
    const lower = bone(`${side}ForeArm`, upper, 0.25 * f, 0, 0);
    const hand = bone(`${side}Hand`, lower, 0.25 * f, 0, 0);

    // Fingers extend further along the arm axis, curling would bend them -Y.
    let joint: THREE.Object3D = hand;
    for (const i of [1, 2, 3]) {
      joint = bone(`${side}HandIndex${i}`, joint, 0.03 * f, 0, 0);
    }
    let thumb: THREE.Object3D = hand;
    for (const i of [1, 2, 3]) {
      thumb = bone(`${side}HandThumb${i}`, thumb, 0.02 * f, 0, 0.015);
    }

    const upLeg = bone(`${side}UpLeg`, hips, 0.08 * f, -0.05, 0);
    const leg = bone(`${side}Leg`, upLeg, 0, -0.45, 0);
    bone(`${side}Foot`, leg, 0, -0.45, 0);
  }

  root.updateMatrixWorld(true);
  return root;
}

/** MediaPipe hand landmarks: 0 wrist, 1-4 thumb, 5-8 index, 9-12 middle,
 * 13-16 ring, 17-20 pinky. Image coords, so smaller y is higher. `curl` 0 is a
 * flat open palm with fingers up; 1 folds the fingertips back to the palm. */
function handLandmarks(curl: number): { x: number; y: number; z: number }[] {
  const wristY = 0.8;
  const pts: { x: number; y: number; z: number }[] = [];
  const push = (x: number, y: number, z = 0) => pts.push({ x, y, z });

  push(0.5, wristY); // wrist

  // Thumb sticks out sideways; left mostly untouched by curl.
  for (let i = 1; i <= 4; i++) {
    push(0.5 - 0.03 * i, wristY - 0.02 * i, 0);
  }

  // Four fingers: extended length shrinks as curl rises.
  const fingerX = [0.47, 0.5, 0.53, 0.56];
  for (const x of fingerX) {
    for (let j = 1; j <= 4; j++) {
      const reach = 0.055 * j * (1 - 0.8 * curl);
      push(x, wristY - reach, 0);
    }
  }
  return pts;
}

/** Wraps a rigged model as the MotionAvatar the bridge expects. */
function asAvatar(root: THREE.Object3D) {
  const rig = buildHumanoidRig(root);
  const scene = new THREE.Scene();
  scene.add(root);
  scene.add(rig.rigRoot);
  scene.updateMatrixWorld(true);

  const avatar = {
    scene: root,
    humanoid: rig.humanoid,
    expressionManager: null,
    extraRoots: [rig.rigRoot],
    source: "fbx",
    notes: [],
    update: () => rig.humanoid.update(),
  } as unknown as MotionAvatar;

  return { avatar, scene, humanoid: rig.humanoid };
}

function worldOf(node: THREE.Object3D): THREE.Vector3 {
  node.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
}

/** Distance from the hand bone to the fingertip bone after applying `curl`.
 * Rotations are slerped toward the target, so step the frame a few times. */
function fingertipReach(curl: number): number {
  const { avatar, scene, humanoid } = asAvatar(buildRigWithFingers());
  const handRig = Kalidokit.Hand.solve(handLandmarks(curl), "Left");
  assert.ok(handRig, "Kalidokit should solve the synthetic hand");
  for (let i = 0; i < 40; i++) {
    applyHandRig(avatar, handRig, "Left");
    humanoid.update();
    scene.updateMatrixWorld(true);
  }
  const hand = worldOf(humanoid.getRawBoneNode("leftHand")!);
  const tip = worldOf(humanoid.getRawBoneNode("leftIndexDistal")!);
  return hand.distanceTo(tip);
}

test("a curled hand actually moves the finger bones", () => {
  const open = fingertipReach(0);
  const closed = fingertipReach(1);

  assert.ok(open > 0, "open hand should have a measurable finger span");
  // NOTE: distance alone does NOT prove the curl DIRECTION — bending a finger
  // backwards shortens the wrist->tip span just as much as curling it forwards,
  // which is why an earlier version of this test passed with the sign inverted.
  // This pair is only a "something moved" check; the signed test below guards
  // direction.
  assert.ok(
    closed < open * 0.9,
    `curling should change the finger span: open=${open.toFixed(4)} closed=${closed.toFixed(4)}`
  );
});

/** Local Z of a normalized finger bone after applying a full curl. */
function fingerCurlZ(side: "Left" | "Right", bone: string): number {
  const { avatar, scene, humanoid } = asAvatar(buildRigWithFingers());
  const handRig = Kalidokit.Hand.solve(handLandmarks(1), side);
  for (let i = 0; i < 40; i++) {
    applyHandRig(avatar, handRig, side);
    humanoid.update();
    scene.updateMatrixWorld(true);
  }
  const node = humanoid.getNormalizedBoneNode(bone as never)!;
  return new THREE.Euler().setFromQuaternion(node.quaternion, "XYZ").z;
}

test("finger curl keeps Kalidokit's per-side sign (curl, not hyperextension)", () => {
  // Kalidokit drives fingers on Z ALONE and already clamps it to the
  // anatomically valid half-range per side — rigFingers clamps to [-PI, 0] for
  // the right hand and [0, PI] for the left. The mapping must pass that sign
  // through untouched: negating it (as the pose bones do, for a different
  // convention) bends every finger backwards instead of mirroring it.
  const leftZ = fingerCurlZ("Left", "leftIndexProximal");
  const rightZ = fingerCurlZ("Right", "rightIndexProximal");

  assert.ok(leftZ > 0.05, `left-hand curl must be +Z, got ${leftZ.toFixed(3)}`);
  assert.ok(rightZ < -0.05, `right-hand curl must be -Z, got ${rightZ.toFixed(3)}`);
});

test("the wrist takes its roll from the arm chain, not from the palm", () => {
  // Kalidokit's hand solver folds its palm-plane roll into yaw as well
  // (handRotation.y = handRotation.z), so feeding its z straight in snaps the
  // hand to a broken angle. Roll comes from the pose rig's Hand.z instead.
  const { avatar, scene, humanoid } = asAvatar(buildRigWithFingers());
  const handRig = Kalidokit.Hand.solve(handLandmarks(0), "Left");

  for (let i = 0; i < 40; i++) {
    applyHandRig(avatar, handRig, "Left", 0.5);
    humanoid.update();
    scene.updateMatrixWorld(true);
  }
  const z = new THREE.Euler().setFromQuaternion(
    humanoid.getNormalizedBoneNode("leftHand")!.quaternion,
    "XYZ"
  ).z;
  // flipZ applies to this pose-derived z, so +0.5 in must come out negative.
  assert.ok(z < -0.2, `pose roll should reach the wrist, got ${z.toFixed(3)}`);
});

test("world landmarks inherit visibility from the normalized list", () => {
  // Kalidokit throws an arm away (substituting a resting default) when the
  // wrist's world-landmark visibility is under 0.23, and MediaPipe often leaves
  // it at 0 there — which is what pinned the arms in a resting pose on device.
  const world = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 1, z: 1, visibility: 0 },
  ];
  const normalized = [{ visibility: 0.97 }, { visibility: 0.88 }];

  const merged = withLandmarkVisibility(world, normalized)!;
  assert.equal(merged[0].visibility, 0.97);
  assert.equal(merged[1].visibility, 0.88, "a zero must be replaced, not kept");
  assert.equal(merged[1].x, 1, "coordinates must survive untouched");

  // Never downgrade a real world-landmark value.
  const better = withLandmarkVisibility([{ x: 0, y: 0, z: 0, visibility: 0.9 }], [
    { visibility: 0.1 },
  ])!;
  assert.equal(better[0].visibility, 0.9);
});

/** Pose landmark array with only the given indices visible. */
function visibilityAt(entries: Record<number, number>): { visibility?: number }[] {
  const lm: { visibility?: number }[] = new Array(33)
    .fill(null)
    .map(() => ({ visibility: 0 }));
  for (const [i, v] of Object.entries(entries)) lm[Number(i)] = { visibility: v };
  return lm;
}

test("hidden hips must not freeze the arms", () => {
  // The regression that shipped: sitting close to the camera puts the hips out
  // of frame, and a single early return on hip visibility froze the arms too —
  // the avatar held a T-pose while the hands and face tracked fine.
  const seated = visibilityAt({
    11: 0.99, // shoulders visible
    12: 0.99,
    13: 0.95, // elbows visible
    14: 0.95,
    23: 0.05, // hips out of frame
    24: 0.05,
    25: 0.0, // knees out of frame
    26: 0.0,
  });

  const gates = resolvePoseGates(seated, "upper");
  assert.equal(gates.arms, true, "shoulders are tracked, so the arms must move");
  assert.equal(gates.torso, false, "no hip line -> don't let the torso wander");
  assert.equal(gates.legs, false);
});

test("pose gates follow the visible landmarks and the mode", () => {
  const wholeBody = visibilityAt({
    11: 0.99, 12: 0.99, 23: 0.9, 24: 0.9, 25: 0.8, 26: 0.8,
  });
  assert.deepEqual(resolvePoseGates(wholeBody, "full"), {
    torso: true,
    arms: true,
    legs: true,
  });
  // Face+hands mode never drives legs, however visible they are.
  assert.equal(resolvePoseGates(wholeBody, "upper").legs, false);

  // Nothing tracked at all -> drive nothing.
  assert.deepEqual(resolvePoseGates(visibilityAt({}), "full"), {
    torso: false,
    arms: false,
    legs: false,
  });
  assert.deepEqual(resolvePoseGates(undefined, "full"), {
    torso: false,
    arms: false,
    legs: false,
  });
});

test("blendshapes drive blink per eye with a dead zone", () => {
  const rest = vrmExpressionsFromBlendshapes([
    { categoryName: "eyeBlinkLeft", score: 0.1 },
    { categoryName: "eyeBlinkRight", score: 0.1 },
  ]);
  assert.equal(rest.blinkLeft, 0, "small scores are noise and must read as open");
  assert.equal(rest.blinkRight, 0);
});

test("a wink mirrors: the subject's left eye closes the avatar's right", () => {
  // ARKit names are anatomical, the avatar is a reflection. Shipping this
  // unmirrored made the wrong eye wink on a real device.
  const winkSubjectLeft = vrmExpressionsFromBlendshapes([
    { categoryName: "eyeBlinkLeft", score: 0.95 },
    { categoryName: "eyeBlinkRight", score: 0.05 },
  ]);
  assert.equal(winkSubjectLeft.blinkRight, 1, "should close the avatar's right eye");
  assert.equal(winkSubjectLeft.blinkLeft, 0, "eyes must stay independent");

  const winkSubjectRight = vrmExpressionsFromBlendshapes([
    { categoryName: "eyeBlinkRight", score: 0.95 },
  ]);
  assert.equal(winkSubjectRight.blinkLeft, 1);
  assert.equal(winkSubjectRight.blinkRight, 0);
});

test("horizontal gaze mirrors too", () => {
  // eyeLookOutLeft = left eye outward = gazing to the subject's own left.
  const gazingSubjectLeft = vrmExpressionsFromBlendshapes([
    { categoryName: "eyeLookOutLeft", score: 0.8 },
    { categoryName: "eyeLookInLeft", score: 0.05 },
  ]);
  assert.ok(gazingSubjectLeft.lookRight > 0.7, "mirrors to the avatar's right");
  assert.equal(gazingSubjectLeft.lookLeft, 0);
});

test("only the dominant vowel is emitted", () => {
  // An open smile scores jawOpen AND mouthSmile; blending several VRM visemes
  // at once turns the mouth to mush, so exactly one must win.
  const weights = vrmExpressionsFromBlendshapes([
    { categoryName: "jawOpen", score: 0.8 },
    { categoryName: "mouthSmileLeft", score: 0.5 },
    { categoryName: "mouthSmileRight", score: 0.5 },
    { categoryName: "mouthPucker", score: 0.2 },
  ]);

  assert.equal(weights.aa, 0.8, "jawOpen is strongest, so aa wins");
  for (const vowel of ["ih", "ou", "ee", "oh"]) {
    assert.equal(weights[vowel], 0, `${vowel} must be silenced`);
  }
  // Emotion presets still ride along with the smile.
  assert.ok(weights.happy > 0);
});

test("gaze and brows resolve to one direction at a time", () => {
  const lookingUp = vrmExpressionsFromBlendshapes([
    { categoryName: "eyeLookUpLeft", score: 0.7 },
    { categoryName: "eyeLookUpRight", score: 0.7 },
    { categoryName: "eyeLookDownLeft", score: 0.2 },
    { categoryName: "eyeLookDownRight", score: 0.2 },
    { categoryName: "browInnerUp", score: 0.6 },
  ]);
  assert.ok(lookingUp.lookUp > 0.6);
  assert.equal(lookingUp.lookDown, 0, "up and down must not fight each other");
  assert.ok(lookingUp.surprised > 0.5);
});
