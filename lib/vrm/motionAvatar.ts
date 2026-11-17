// The thing the motion pipeline actually drives.
//
// Originally this was `VRM` everywhere, but FBX/glTF rigs can be adapted to the
// same normalized-humanoid interface (see humanoidRigger.ts), so the tracker
// only needs this narrow surface. A real VRM brings expressions + spring bones
// along; an adapted rig drives bones only.

import type * as THREE from "three";
import type { VRM, VRMHumanoid, VRMExpressionManager } from "@pixiv/three-vrm";
import type { RiggedModel } from "./humanoidRigger";

export type AvatarSource = "vrm" | "fbx" | "gltf";

export interface MotionAvatar {
  /** Root object added to the scene. */
  scene: THREE.Object3D;
  humanoid: VRMHumanoid;
  /** Only real VRMs have blend shapes for blink/mouth tracking. */
  expressionManager: VRMExpressionManager | null;
  /** Extra roots that must live in the scene at identity transform. */
  extraRoots: THREE.Object3D[];
  source: AvatarSource;
  /** Warnings/fixes to surface in the UI (rest-pose corrections, no expressions…). */
  notes: string[];
  update(delta: number): void;
}

export function avatarFromVRM(vrm: VRM): MotionAvatar {
  return {
    scene: vrm.scene,
    humanoid: vrm.humanoid,
    expressionManager: vrm.expressionManager ?? null,
    extraRoots: [],
    source: "vrm",
    notes: [],
    update: (delta) => vrm.update(delta),
  };
}

export function avatarFromRiggedModel(
  root: THREE.Object3D,
  rig: RiggedModel,
  source: AvatarSource
): MotionAvatar {
  return {
    scene: root,
    humanoid: rig.humanoid,
    // No VRM expression set: blink/mouth tracking is skipped by the bridge.
    expressionManager: null,
    extraRoots: [rig.rigRoot],
    source,
    notes: [...rig.notes, "표정(눈 깜빡임·입 모양)은 VRM 파일에서만 동작합니다"],
    // The GLTF/FBX path has no spring bones or constraints to tick — only the
    // humanoid needs to copy the normalized pose onto the raw bones.
    update: () => rig.humanoid.update(),
  };
}
