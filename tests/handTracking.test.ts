import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildHumanoidRig, classifyBoneName } from "../lib/vrm/humanoidRigger.ts";
import {
  applyHandRig,
  resolvePoseGates,
  rigFaceRotation,
  solveFingerRig,
  vrmSideForHand,
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
    // Left on +X, matching VRM 1.0 (+Z facing) — see realAvatarHands.test.ts.
    const f = side === "Left" ? 1 : -1;
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
  // The user's left hand drives the avatar's right (mirrored).
  const vrmSide = vrmSideForHand("Left");
  for (let i = 0; i < 40; i++) {
    applyHandRig(avatar, handRig, "Left", vrmSide);
    humanoid.update();
    scene.updateMatrixWorld(true);
  }
  const hand = worldOf(humanoid.getRawBoneNode(`${vrmSide}Hand`)!);
  const tip = worldOf(humanoid.getRawBoneNode(`${vrmSide}IndexDistal`)!);
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

/** Local Z of the avatar's finger bone after applying a full curl of `side`. */
function fingerCurlZ(side: "Left" | "Right"): number {
  const { avatar, scene, humanoid } = asAvatar(buildRigWithFingers());
  const handRig = Kalidokit.Hand.solve(handLandmarks(1), side);
  const vrmSide = vrmSideForHand(side);
  for (let i = 0; i < 40; i++) {
    applyHandRig(avatar, handRig, side, vrmSide);
    humanoid.update();
    scene.updateMatrixWorld(true);
  }
  const node = humanoid.getNormalizedBoneNode(`${vrmSide}IndexProximal` as never)!;
  return new THREE.Euler().setFromQuaternion(node.quaternion, "XYZ").z;
}

test("a curl lands with the sign the target avatar hand needs", () => {
  // Measured on the real avatar (scratch/probe_vrm_axes.mjs): the palm faces -Y
  // at rest, and the avatar's LEFT index curls on -Z while its RIGHT curls on
  // +Z. Kalidokit emits a left-hand curl as +z and a right-hand curl as -z, and
  // the mirror crossing pairs those up exactly — user's left (+z) lands on the
  // avatar's right (needs +z). That's why no flip is applied here.
  // The geometric version of this check is in tests/realAvatarHands.test.ts.
  const fromUserLeft = fingerCurlZ("Left"); // -> avatar right, wants +Z
  const fromUserRight = fingerCurlZ("Right"); // -> avatar left, wants -Z

  assert.ok(fromUserLeft > 0.05, `avatar right curl must be +Z, got ${fromUserLeft.toFixed(3)}`);
  assert.ok(fromUserRight < -0.05, `avatar left curl must be -Z, got ${fromUserRight.toFixed(3)}`);
});

test("the wrist is left alone when no orientation is supplied", () => {
  // Kalidokit's wrist rotation is never used: it copies its palm-plane roll into
  // yaw (handRotation.y = handRotation.z, biased by -0.4), which twists the hand
  // off the forearm. lib/vrm/wristSolver.ts supplies the orientation instead, and
  // when it can't (degenerate landmarks) the wrist must simply not move.
  const { avatar, scene, humanoid } = asAvatar(buildRigWithFingers());
  const handRig = Kalidokit.Hand.solve(handLandmarks(0), "Left");
  const wristBone = humanoid.getNormalizedBoneNode(
    `${vrmSideForHand("Left")}Hand` as never
  )!;
  const before = wristBone.quaternion.clone();

  for (let i = 0; i < 40; i++) {
    applyHandRig(avatar, handRig, "Left", vrmSideForHand("Left"), null);
    humanoid.update();
    scene.updateMatrixWorld(true);
  }
  assert.ok(
    wristBone.quaternion.angleTo(before) < 1e-6,
    "no wrist orientation means no wrist rotation"
  );
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

test("face rotations negate pitch and roll, but not yaw", () => {
  // Kalidokit's head rotation is VRM0 raw-bone convention, and VRM0 -> VRM1 is a
  // 180-degree turn about Y, which negates the X and Z components. Roll was fixed
  // first (head tilt went the wrong way); pitch was inverted too — looking down
  // made the avatar look up. Yaw survives the turn and must be left alone.
  const { avatar, scene, humanoid } = asAvatar(buildRigWithFingers());
  const head = humanoid.getNormalizedBoneNode("head" as never)!;

  for (let i = 0; i < 60; i++) {
    rigFaceRotation(avatar, "head", { x: 0.4, y: 0.3, z: 0.2 }, 1, 0.6);
    humanoid.update();
    scene.updateMatrixWorld(true);
  }
  const applied = new THREE.Euler().setFromQuaternion(head.quaternion, "XYZ");

  assert.ok(applied.x < -0.2, `pitch must be negated, got ${applied.x.toFixed(3)}`);
  assert.ok(applied.y > 0.1, `yaw must pass through, got ${applied.y.toFixed(3)}`);
  assert.ok(applied.z < -0.05, `roll must be negated, got ${applied.z.toFixed(3)}`);
});

test("the thumb curls with the other fingers' convention, no constant offset", () => {
  // Kalidokit's thumb branch carries VRM0-era constants (startPos.x alone is 1.2
  // rad), and VRM 1.0 shifted the thumb chain by a joint, so those offsets landed
  // on the wrong joint and bent the thumb off on its own. solveFingerRig replaces
  // it with the finger formula.
  // The solver reads all five digits, so the four fingers have to exist even when
  // the thumb is what's under test — laid out straight, so they read as open and
  // can't be confused for the thumb's contribution.
  // Each finger runs along a ray FROM THE WRIST, so wrist/knuckle/joints are
  // exactly collinear and the knuckle angle really is zero. Fanning them out from
  // a shared column instead tilts wrist->knuckle away from the finger's own axis,
  // which is a genuine bend of ~35 degrees — a fixture that looks open but isn't.
  const withOpenFingers = (thumb: { x: number; y: number; z: number }[]) => {
    const wrist = thumb[0];
    const pts = [...thumb];
    for (let digit = 0; digit < 4; digit++) {
      const dx = 0.02 * (digit - 1.5);
      const len = Math.hypot(dx, 0.05);
      for (let joint = 1; joint <= 4; joint++) {
        pts.push({
          x: wrist.x + (dx / len) * 0.05 * joint,
          y: wrist.y - (0.05 / len) * 0.05 * joint,
          z: 0,
        });
      }
    }
    return pts;
  };

  const straight = withOpenFingers([
    { x: 0.5, y: 0.8, z: 0 },
    { x: 0.47, y: 0.76, z: 0 },
    { x: 0.44, y: 0.72, z: 0 },
    { x: 0.41, y: 0.68, z: 0 },
    { x: 0.38, y: 0.64, z: 0 },
  ]);
  const restRig = solveFingerRig(straight, "Left");
  for (const [key, rot] of Object.entries(restRig)) {
    assert.ok(
      Math.abs(rot.z) < 0.2,
      `a straight thumb must stay near rest, ${key} got z=${rot.z.toFixed(3)}`
    );
    assert.equal(rot.x, 0, "no constant offset on x — that was the old bug");
    assert.equal(rot.y, 0);
  }

  // A bent thumb: fold the tip back so each joint has a real angle.
  const bent = withOpenFingers([
    { x: 0.5, y: 0.8, z: 0 },
    { x: 0.47, y: 0.76, z: 0 },
    { x: 0.45, y: 0.72, z: 0 },
    { x: 0.47, y: 0.7, z: 0 },
    { x: 0.5, y: 0.71, z: 0 },
  ]);
  const thumbZ = (rig: Record<string, { z: number }>, side: "Left" | "Right") =>
    ["Proximal", "Intermediate", "Distal"].map((j) => rig[`${side}Thumb${j}`].z);

  // Same per-side signs as the four fingers, so the mirror crossing lines up.
  const leftBent = thumbZ(solveFingerRig(bent, "Left"), "Left");
  const rightBent = thumbZ(solveFingerRig(bent, "Right"), "Right");
  assert.ok(
    leftBent.some((z) => z > 0.1),
    `left thumb should bend +Z, got ${JSON.stringify(leftBent)}`
  );
  assert.ok(
    rightBent.some((z) => z < -0.1),
    `right thumb should bend -Z, got ${JSON.stringify(rightBent)}`
  );
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
