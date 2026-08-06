// Builds a VRM humanoid out of a NON-VRM skinned model (FBX, plain glTF).
//
// Why this exists: the motion pipeline (lib/vrm/kalidokitBridge.ts) drives
// three-vrm's *normalized* humanoid bones. That abstraction is what makes
// Kalidokit's output portable — it gives every rig the same canonical bone
// names and the same axis frame. An FBX has neither: bone names are whatever the
// DCC tool emitted (`mixamorig:LeftForeArm`, `Bip001 L UpperArm`, `thigh.L`),
// and the rest pose is usually an A-pose.
//
// `VRMHumanoid` is publicly constructible from a plain bone map, so we can reuse
// three-vrm's normalization for a foreign rig once we solve two problems:
//
//  1. NAME MAPPING — match the rig's bones to VRM human bone names by tokenizing
//     the node names, which covers the common conventions without a per-rig table.
//
//  2. REST POSE — VRMHumanoidRig.update() folds each bone's rest rotation back in
//     as the zero point, so *the source model's rest pose becomes the identity
//     pose*. VRM works today only because the spec mandates T-pose. Kalidokit
//     also solves against T-pose, so an A-posed FBX would render every arm ~45°
//     too low. We therefore rotate the limbs into a real T-pose (and fix up-axis,
//     facing and scale) BEFORE constructing the humanoid, so the normalized zero
//     lines up with what Kalidokit expects.
//
// Fingers, eyes and jaw are intentionally not mapped: the tracker doesn't drive
// them, and guessing finger chains from names is where this kind of heuristic
// usually goes wrong.

import * as THREE from "three";
import { VRMHumanoid, VRMHumanBoneName } from "@pixiv/three-vrm";
import type { VRMHumanBones } from "@pixiv/three-vrm";

/** Bones we must find or the pipeline has nothing meaningful to drive. */
const REQUIRED: VRMHumanBoneName[] = [
  "hips",
  "spine",
  "head",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
];

/** Rig helpers that must never be mistaken for a humanoid bone. */
const SKIP_TOKENS = new Set([
  "twist",
  "roll",
  "ik",
  "fk",
  "pole",
  "helper",
  "dummy",
  "null",
  "socket",
  "adjust",
  "target",
  "ctrl",
  "control",
  "tip",
  "end",
  "aux",
  "attach",
  "weapon",
  "prop",
  "cloth",
  "skirt",
  "hair",
  "tail",
  "breast",
  "bust",
]);

const FINGER_TOKENS = new Set([
  "thumb",
  "index",
  "middle",
  "ring",
  "pinky",
  "little",
  "finger",
  "f00",
  "f01",
]);

/** Target height in metres after normalization (FBX is very often in cm). */
const TARGET_HEIGHT = 1.6;

export interface RiggedModel {
  humanoid: VRMHumanoid;
  /** The normalized rig root. Must be added to the scene at IDENTITY transform
   * (NOT under the scaled model root) — the rig's bone offsets are absolute
   * world positions measured after normalization. */
  rigRoot: THREE.Object3D;
  mapped: VRMHumanBoneName[];
  /** Human-readable notes about the fixes applied, surfaced in the UI. */
  notes: string[];
}

/** Splits a bone node name into lowercase tokens, handling the naming styles
 * that show up in the wild: `mixamorig:LeftForeArm`, `Bip001 L UpperArm`,
 * `J_Bip_L_UpperArm`, `thigh.L`, `Spine1`. */
export function tokenizeBoneName(name: string): string[] {
  const withoutPrefix = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
  return withoutPrefix
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

type Side = "left" | "right" | null;

function detectSide(tokens: string[]): Side {
  if (tokens.includes("left") || tokens.includes("l")) return "left";
  if (tokens.includes("right") || tokens.includes("r")) return "right";
  return null;
}

function sided(side: Side, left: VRMHumanBoneName, right: VRMHumanBoneName): VRMHumanBoneName | null {
  if (side === "left") return left;
  if (side === "right") return right;
  return null;
}

/** Maps one bone node name to a VRM human bone name, or null if it isn't one. */
export function classifyBoneName(name: string): VRMHumanBoneName | null {
  const tokens = tokenizeBoneName(name);
  if (tokens.length === 0) return null;
  if (tokens.some((t) => SKIP_TOKENS.has(t))) return null;
  if (tokens.some((t) => FINGER_TOKENS.has(t))) return null;

  const has = (t: string) => tokens.includes(t);
  const side = detectSide(tokens);
  const numToken = tokens.find((t) => /^\d+$/.test(t));
  const num = numToken ? parseInt(numToken, 10) : null;

  // Torso / head — no side.
  if (has("hips") || has("hip") || has("pelvis")) return "hips";
  if (has("spine")) {
    if (num === 2 || num === 3) return "upperChest";
    if (num === 1) return "chest";
    return "spine";
  }
  if (has("chest")) return has("upper") ? "upperChest" : "chest";
  if (has("neck")) return "neck";
  if (has("head")) return "head";

  if (!side) return null;

  if (has("shoulder") || has("clavicle")) return sided(side, "leftShoulder", "rightShoulder");
  if (has("arm")) {
    if (has("fore") || has("lower")) return sided(side, "leftLowerArm", "rightLowerArm");
    // Mixamo's plain "LeftArm" is the upper arm.
    return sided(side, "leftUpperArm", "rightUpperArm");
  }
  if (has("hand") || has("wrist")) return sided(side, "leftHand", "rightHand");
  if (has("toe") || has("ball")) return sided(side, "leftToes", "rightToes");
  if (has("foot") || has("ankle")) return sided(side, "leftFoot", "rightFoot");
  if (has("thigh")) return sided(side, "leftUpperLeg", "rightUpperLeg");
  if (has("calf") || has("shin")) return sided(side, "leftLowerLeg", "rightLowerLeg");
  if (has("leg")) {
    if (has("up") || has("upper")) return sided(side, "leftUpperLeg", "rightUpperLeg");
    // Mixamo's plain "LeftLeg" is the shin ("LeftUpLeg" is the thigh).
    return sided(side, "leftLowerLeg", "rightLowerLeg");
  }

  return null;
}

function collectBones(root: THREE.Object3D): Partial<Record<VRMHumanBoneName, THREE.Object3D>> {
  const found: Partial<Record<VRMHumanBoneName, THREE.Object3D>> = {};
  const depthOf: Partial<Record<VRMHumanBoneName, number>> = {};

  const visit = (node: THREE.Object3D, depth: number) => {
    const boneName = classifyBoneName(node.name);
    if (boneName) {
      // Prefer the candidate closest to the root: duplicated names deeper in the
      // hierarchy are usually deform/child helpers.
      const prev = depthOf[boneName];
      if (prev === undefined || depth < prev) {
        found[boneName] = node;
        depthOf[boneName] = depth;
      }
    }
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);

  return found;
}

function worldPos(node: THREE.Object3D, out = new THREE.Vector3()): THREE.Vector3 {
  node.updateWorldMatrix(true, false);
  return out.setFromMatrixPosition(node.matrixWorld);
}

/** Rotates `bone` so that the `bone`→`tip` direction points along `target`,
 * applying the delta in world space. Used to force limbs into a T-pose. */
function alignChain(
  bone: THREE.Object3D,
  tip: THREE.Object3D,
  target: THREE.Vector3,
  minDeg = 3
): number {
  const from = worldPos(tip).sub(worldPos(bone, new THREE.Vector3()));
  if (from.lengthSq() < 1e-8) return 0;
  from.normalize();

  const angle = from.angleTo(target);
  if (angle < THREE.MathUtils.degToRad(minDeg)) return 0;

  const axis = new THREE.Vector3().crossVectors(from, target);
  if (axis.lengthSq() < 1e-10) return 0; // exactly opposite — ambiguous, leave it
  axis.normalize();

  const delta = new THREE.Quaternion().setFromAxisAngle(axis, angle);

  // World-space delta -> local: Lnew = inv(P) * delta * P * L
  const parentWorld = new THREE.Quaternion();
  bone.parent?.getWorldQuaternion(parentWorld);
  const local = new THREE.Quaternion()
    .copy(parentWorld)
    .invert()
    .multiply(delta)
    .multiply(parentWorld)
    .multiply(bone.quaternion);

  bone.quaternion.copy(local);
  bone.updateWorldMatrix(false, true);
  return THREE.MathUtils.radToDeg(angle);
}

/** Bounding box of the model. Prefers the rendered geometry, but falls back to
 * the bone positions: `Box3.setFromObject` only expands by geometry, so a rig
 * with no skinned mesh yields an EMPTY box whose min is +Infinity — which would
 * turn the scale/ground math into NaN. */
function measureModel(
  root: THREE.Object3D,
  bones: Partial<Record<VRMHumanBoneName, THREE.Object3D>>
): { box: THREE.Box3; size: THREE.Vector3; fromBones: boolean } {
  root.updateMatrixWorld(true);

  const meshBox = new THREE.Box3().setFromObject(root);
  if (!meshBox.isEmpty() && Number.isFinite(meshBox.min.y)) {
    return { box: meshBox, size: meshBox.getSize(new THREE.Vector3()), fromBones: false };
  }

  const boneBox = new THREE.Box3();
  for (const node of Object.values(bones)) {
    if (node) boneBox.expandByPoint(worldPos(node));
  }
  return { box: boneBox, size: boneBox.getSize(new THREE.Vector3()), fromBones: true };
}

/** Fixes up-axis, scale, ground offset, facing direction and rest pose so the
 * model matches the VRM 1.0 conventions the tracker assumes. */
function normalizeRestPose(
  root: THREE.Object3D,
  bones: Partial<Record<VRMHumanBoneName, THREE.Object3D>>
): string[] {
  const notes: string[] = [];
  root.updateMatrixWorld(true);

  // 1) Z-up rigs (3ds Max / some Blender exports) come in lying on their back.
  let { size } = measureModel(root, bones);
  if (size.y > 1e-6 && size.z > size.y * 1.4) {
    root.rotateX(-Math.PI / 2);
    root.updateMatrixWorld(true);
    notes.push("Z-up 축을 Y-up으로 보정");
  }

  // 2) FBX is usually authored in centimetres -> normalize to ~1.6 m. A
  //    bone-derived height stops at the head joint, so pad for the skull.
  const measured = measureModel(root, bones);
  const height = measured.fromBones ? measured.size.y * 1.08 : measured.size.y;
  if (height > 1e-6) {
    const scale = TARGET_HEIGHT / height;
    if (scale < 0.9 || scale > 1.1) {
      root.scale.multiplyScalar(scale);
      root.updateMatrixWorld(true);
      notes.push(`크기를 ${height.toFixed(1)} → ${TARGET_HEIGHT}m로 정규화`);
    }
  }

  // 3) Put the feet on the ground so the existing camera framing works.
  const grounded = measureModel(root, bones);
  if (Number.isFinite(grounded.box.min.y) && Math.abs(grounded.box.min.y) > 0.02) {
    root.position.y -= grounded.box.min.y;
    root.updateMatrixWorld(true);
  }

  // 4) VRM 1.0 faces +Z, which puts the character's LEFT at -X. If the rig's
  //    left arm sits on +X it is facing away from the camera; spin it around.
  const leftArm = bones.leftUpperArm;
  const rightArm = bones.rightUpperArm;
  if (leftArm && rightArm) {
    const lx = worldPos(leftArm).x;
    const rx = worldPos(rightArm).x;
    if (lx > rx) {
      root.rotateY(Math.PI);
      root.updateMatrixWorld(true);
      notes.push("정면 방향을 180° 보정");
    }
  }

  // 5) A-pose -> T-pose. This is the one that actually matters: the rest pose
  //    becomes the tracker's zero, and Kalidokit solves against T-pose.
  let armFix = 0;
  if (bones.leftUpperArm && bones.leftHand) {
    armFix = Math.max(
      armFix,
      alignChain(bones.leftUpperArm, bones.leftHand, new THREE.Vector3(-1, 0, 0))
    );
  }
  if (bones.rightUpperArm && bones.rightHand) {
    armFix = Math.max(
      armFix,
      alignChain(bones.rightUpperArm, bones.rightHand, new THREE.Vector3(1, 0, 0))
    );
  }
  if (armFix > 0) {
    notes.push(`팔 rest 포즈를 T-pose로 보정 (최대 ${Math.round(armFix)}°)`);
  }

  // 6) Legs should hang straight down.
  let legFix = 0;
  if (bones.leftUpperLeg && bones.leftFoot) {
    legFix = Math.max(
      legFix,
      alignChain(bones.leftUpperLeg, bones.leftFoot, new THREE.Vector3(0, -1, 0), 5)
    );
  }
  if (bones.rightUpperLeg && bones.rightFoot) {
    legFix = Math.max(
      legFix,
      alignChain(bones.rightUpperLeg, bones.rightFoot, new THREE.Vector3(0, -1, 0), 5)
    );
  }
  if (legFix > 0) {
    notes.push(`다리 rest 포즈를 수직으로 보정 (최대 ${Math.round(legFix)}°)`);
  }

  root.updateMatrixWorld(true);
  return notes;
}

/** Turns an arbitrary skinned model into something the VRM motion pipeline can
 * drive. Throws with a Korean, user-facing message when the rig is unusable. */
export function buildHumanoidRig(root: THREE.Object3D): RiggedModel {
  const bones = collectBones(root);

  const missing = REQUIRED.filter((name) => !bones[name]);
  if (missing.length > 0) {
    // Nothing recognized at all is almost always "this file has no skeleton"
    // (a static prop, or a mesh-only export).
    if (Object.keys(bones).length === 0) {
      throw new Error(
        "이 파일에서 사람형 뼈대(스켈레톤)를 찾지 못했어요. 스킨/본이 포함된 캐릭터 파일인지 확인해 주세요."
      );
    }
    throw new Error(
      `뼈대 이름을 자동으로 인식하지 못했어요 (누락: ${missing.join(", ")}). ` +
        "Mixamo 계열 표준 이름(Hips/Spine/LeftArm…)을 쓰는 파일이면 잘 동작합니다."
    );
  }

  const notes = normalizeRestPose(root, bones);

  // Skinned meshes get culled by their ORIGINAL bounds, so a raised arm can pop
  // the whole mesh out of view once we start moving bones.
  root.traverse((obj) => {
    obj.frustumCulled = false;
  });

  const humanBones = {} as VRMHumanBones;
  const mapped: VRMHumanBoneName[] = [];
  for (const [name, node] of Object.entries(bones) as [VRMHumanBoneName, THREE.Object3D][]) {
    humanBones[name] = { node };
    mapped.push(name);
  }

  const humanoid = new VRMHumanoid(humanBones);

  return {
    humanoid,
    rigRoot: humanoid.normalizedHumanBonesRoot,
    mapped,
    notes,
  };
}
