import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildHumanoidRig, classifyBoneName, tokenizeBoneName } from "../lib/vrm/humanoidRigger.ts";

test("tokenizeBoneName splits the naming styles found in real rigs", () => {
  assert.deepEqual(tokenizeBoneName("mixamorig:LeftForeArm"), ["left", "fore", "arm"]);
  assert.deepEqual(tokenizeBoneName("Bip001 L UpperArm"), ["bip", "001", "l", "upper", "arm"]);
  assert.deepEqual(tokenizeBoneName("J_Bip_L_UpperArm"), ["j", "bip", "l", "upper", "arm"]);
  assert.deepEqual(tokenizeBoneName("thigh.L"), ["thigh", "l"]);
  assert.deepEqual(tokenizeBoneName("Spine1"), ["spine", "1"]);
});

test("classifyBoneName maps the common conventions onto VRM human bones", () => {
  // Mixamo
  assert.equal(classifyBoneName("mixamorig:Hips"), "hips");
  assert.equal(classifyBoneName("mixamorig:Spine"), "spine");
  assert.equal(classifyBoneName("mixamorig:Spine1"), "chest");
  assert.equal(classifyBoneName("mixamorig:Spine2"), "upperChest");
  assert.equal(classifyBoneName("mixamorig:LeftArm"), "leftUpperArm");
  assert.equal(classifyBoneName("mixamorig:LeftForeArm"), "leftLowerArm");
  assert.equal(classifyBoneName("mixamorig:RightHand"), "rightHand");
  assert.equal(classifyBoneName("mixamorig:LeftUpLeg"), "leftUpperLeg");
  assert.equal(classifyBoneName("mixamorig:LeftLeg"), "leftLowerLeg");
  assert.equal(classifyBoneName("mixamorig:LeftToeBase"), "leftToes");
  // Other conventions
  assert.equal(classifyBoneName("Bip001 L UpperArm"), "leftUpperArm");
  assert.equal(classifyBoneName("J_Bip_L_LowerLeg"), "leftLowerLeg");
  assert.equal(classifyBoneName("thigh.R"), "rightUpperLeg");
  assert.equal(classifyBoneName("shin_L"), "leftLowerLeg");
  assert.equal(classifyBoneName("clavicle_r"), "rightShoulder");
  // Fingers map too (needed for hand tracking) — see tests/handTracking.test.ts
  // for the joint-by-joint cases, including VRM 1.0's shifted thumb chain.
  assert.equal(classifyBoneName("mixamorig:LeftHandThumb2"), "leftThumbProximal");
  // Rejected: helpers and unrelated nodes
  assert.equal(classifyBoneName("LeftArmTwist"), null);
  assert.equal(classifyBoneName("IK_Hand_L"), null);
  assert.equal(classifyBoneName("Armature"), null);
});

/** Builds a Mixamo-named skeleton in centimetres. `armDir` decides the rest
 * pose: (-1,0,0) is a T-pose, (-1,-1,0) a 45° A-pose. `facing` mirrors every X
 * offset, so -1 produces a rig whose "left" bones sit on +X — a character
 * modelled facing away from the camera. */
function buildSkeleton(armDir: THREE.Vector3, facing: 1 | -1 = 1): THREE.Object3D {
  const root = new THREE.Object3D();
  root.name = "Armature";

  const bone = (name: string, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const b = new THREE.Bone();
    b.name = `mixamorig:${name}`;
    b.position.set(x, y, z);
    parent.add(b);
    return b;
  };

  const hips = bone("Hips", root, 0, 100, 0);
  const spine = bone("Spine", hips, 0, 10, 0);
  const spine1 = bone("Spine1", spine, 0, 10, 0);
  const spine2 = bone("Spine2", spine1, 0, 10, 0);
  const neck = bone("Neck", spine2, 0, 10, 0);
  bone("Head", neck, 0, 10, 0);

  const dir = armDir.clone().normalize().multiplyScalar(25);
  for (const side of ["Left", "Right"] as const) {
    // Left sits at -X (VRM/+Z-facing convention) unless mirrored by `facing`.
    const flip = (side === "Left" ? -1 : 1) * facing;
    const shoulder = bone(`${side}Shoulder`, spine2, 8 * flip, 8, 0);
    const upper = bone(`${side}Arm`, shoulder, 5 * flip, 0, 0);
    const lower = bone(`${side}ForeArm`, upper, Math.abs(dir.x) * flip, dir.y, dir.z);
    const hand = bone(`${side}Hand`, lower, Math.abs(dir.x) * flip, dir.y, dir.z);
    // A finger, to confirm it is ignored rather than mistaken for the hand.
    bone(`${side}HandIndex1`, hand, Math.abs(dir.x) * flip * 0.2, dir.y * 0.2, 0);

    const upLeg = bone(`${side}UpLeg`, hips, 8 * flip, -5, 0);
    const leg = bone(`${side}Leg`, upLeg, 0, -45, 0);
    const foot = bone(`${side}Foot`, leg, 0, -45, 0);
    bone(`${side}ToeBase`, foot, 0, -5, 10);
  }

  root.updateMatrixWorld(true);
  return root;
}

const APOSE_DIR = new THREE.Vector3(-1, -1, 0);
const TPOSE_DIR = new THREE.Vector3(-1, 0, 0);

function worldOf(node: THREE.Object3D): THREE.Vector3 {
  node.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
}

test("buildHumanoidRig maps every required bone of a Mixamo-style rig", () => {
  const { humanoid, mapped } = buildHumanoidRig(buildSkeleton(APOSE_DIR));

  for (const name of [
    "hips",
    "spine",
    "chest",
    "upperChest",
    "neck",
    "head",
    "leftShoulder",
    "leftUpperArm",
    "leftLowerArm",
    "leftHand",
    "rightUpperArm",
    "rightLowerArm",
    "rightHand",
    "leftUpperLeg",
    "leftLowerLeg",
    "leftFoot",
    "leftToes",
    "rightUpperLeg",
    "rightLowerLeg",
    "rightFoot",
  ] as const) {
    assert.ok(humanoid.getRawBoneNode(name), `missing ${name}`);
    assert.ok(mapped.includes(name), `${name} not reported as mapped`);
  }
  // This fixture has one finger joint per hand, and it maps (fingers are
  // optional, so a rig without them still passes the required-bone check).
  assert.ok(humanoid.getRawBoneNode("leftIndexProximal"), "finger joints should map");
});

test("normalization scales a centimetre rig to human size and puts feet near the floor", () => {
  const { humanoid, notes } = buildHumanoidRig(buildSkeleton(APOSE_DIR));

  const head = worldOf(humanoid.getRawBoneNode("head")!);
  const foot = worldOf(humanoid.getRawBoneNode("leftFoot")!);

  assert.ok(head.y > 1.3 && head.y < 1.75, `head height out of range: ${head.y}`);
  assert.ok(Math.abs(foot.y) < 0.12, `foot not near the floor: ${foot.y}`);
  assert.ok(
    notes.some((n) => n.includes("정규화")),
    `expected a scale note, got ${JSON.stringify(notes)}`
  );
});

test("an A-pose rest pose is corrected to T-pose (the tracker's zero)", () => {
  const { humanoid, notes } = buildHumanoidRig(buildSkeleton(APOSE_DIR));

  for (const side of ["left", "right"] as const) {
    const upper = worldOf(humanoid.getRawBoneNode(`${side}UpperArm`)!);
    const hand = worldOf(humanoid.getRawBoneNode(`${side}Hand`)!);
    const dir = hand.sub(upper).normalize();

    // Horizontal, and pointing to the character's own side (+Z facing → left is -X).
    assert.ok(Math.abs(dir.y) < 0.09, `${side} arm not horizontal: y=${dir.y}`);
    const expectedX = side === "left" ? -1 : 1;
    assert.ok(dir.x * expectedX > 0.95, `${side} arm points the wrong way: x=${dir.x}`);
  }

  assert.ok(
    notes.some((n) => n.includes("T-pose")),
    `expected a rest-pose note, got ${JSON.stringify(notes)}`
  );
});

test("a rig facing away from the camera is spun around to VRM's +Z convention", () => {
  // Mirrored on X: the "left" bones sit on +X, i.e. the character faces -Z.
  const { humanoid, notes } = buildHumanoidRig(buildSkeleton(APOSE_DIR, -1));

  const left = worldOf(humanoid.getRawBoneNode("leftUpperArm")!);
  const right = worldOf(humanoid.getRawBoneNode("rightUpperArm")!);
  assert.ok(left.x < right.x, `left arm should end up at -X: ${left.x} vs ${right.x}`);
  assert.ok(
    notes.some((n) => n.includes("180")),
    `expected a facing note, got ${JSON.stringify(notes)}`
  );

  // ...and the T-pose fix still resolves in the corrected frame.
  const hand = worldOf(humanoid.getRawBoneNode("leftHand")!);
  const dir = hand.sub(left).normalize();
  assert.ok(dir.x < -0.95, `left arm should extend to -X after the fix: ${dir.x}`);
});

/** Drives the normalized bone the way kalidokitBridge does, then reads the raw
 * skeleton back — the end-to-end path the tracker actually uses. */
function poseAndRead(
  root: THREE.Object3D,
  bone: "leftUpperArm",
  euler: THREE.Euler,
  read: "leftHand"
): THREE.Vector3 {
  const { humanoid, rigRoot } = buildHumanoidRig(root);
  // The rig root lives in the scene at identity, exactly like VRMSceneManager does.
  const scene = new THREE.Scene();
  scene.add(root);
  scene.add(rigRoot);
  scene.updateMatrixWorld(true);

  const before = worldOf(humanoid.getRawBoneNode(read)!);

  humanoid.getNormalizedBoneNode(bone)!.quaternion.setFromEuler(euler);
  humanoid.update();
  scene.updateMatrixWorld(true);

  return worldOf(humanoid.getRawBoneNode(read)!).sub(before);
}

test("an adapted A-pose rig responds to normalized rotations like a T-posed one", () => {
  // A side-raise as the bridge emits it: roll about the normalized local Z.
  const raise = new THREE.Euler(0, 0, -0.6, "XYZ");

  const aPose = poseAndRead(buildSkeleton(APOSE_DIR), "leftUpperArm", raise, "leftHand");
  const tPose = poseAndRead(buildSkeleton(TPOSE_DIR), "leftUpperArm", raise, "leftHand");

  // Same input rotation must move the hand the same way on both rigs; without
  // the A-pose→T-pose rest fix the A-pose rig lands ~45° off.
  assert.ok(
    aPose.distanceTo(tPose) < 0.05,
    `A-pose and T-pose rigs diverge: ${JSON.stringify(aPose)} vs ${JSON.stringify(tPose)}`
  );
  // And it must actually raise the hand, not drop it.
  assert.ok(aPose.y > 0.15, `hand did not go up: dy=${aPose.y}`);
});
