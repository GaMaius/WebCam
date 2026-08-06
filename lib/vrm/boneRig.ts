// Writing solver output onto VRM bones: the axis convention, the smoothing, and
// the hand/finger name mapping.
//
// Split out from kalidokitBridge.ts so this can be imported without Kalidokit,
// whose package entry re-exports from directories — fine for bundlers, rejected
// by Node's ESM resolver. That keeps the axis and mapping behavior (the part
// that has actually caused bugs here) under unit test. Deliberately has no
// relative runtime imports for the same reason.

import * as THREE from "three";
import type { MotionAvatar } from "./motionAvatar";

/** A Kalidokit-style euler rotation. */
export type Rot = { x: number; y: number; z: number; rotationOrder?: string };

// Smoothing + deadzone to kill micro-jitter while keeping response snappy.
export const DEADZONE_RAD = 0.02; // ~1.1° — ignore sub-threshold jitter
export const LERP_BODY = 0.3;
export const LERP_LEG = 0.22; // extra damping so legs don't pop
export const LERP_FACE = 0.3;
export const LERP_HAND = 0.4; // fingers should feel snappy; they're small and fast

export type HandSide = "Left" | "Right";

/** Kalidokit's hand rig uses the VRM0 finger naming, where the thumb chain is
 * Proximal/Intermediate/Distal. VRM 1.0 renamed it Metacarpal/Proximal/Distal —
 * the same three joints shifted one name along — so mapping by name alone would
 * put every thumb rotation on the wrong joint. The other four fingers kept their
 * names. Keys are the rig's suffix, values the VRM bone's. */
export const FINGER_BONE_BY_RIG_SUFFIX: Record<string, string> = {
  ThumbProximal: "ThumbMetacarpal",
  ThumbIntermediate: "ThumbProximal",
  ThumbDistal: "ThumbDistal",
  IndexProximal: "IndexProximal",
  IndexIntermediate: "IndexIntermediate",
  IndexDistal: "IndexDistal",
  MiddleProximal: "MiddleProximal",
  MiddleIntermediate: "MiddleIntermediate",
  MiddleDistal: "MiddleDistal",
  RingProximal: "RingProximal",
  RingIntermediate: "RingIntermediate",
  RingDistal: "RingDistal",
  LittleProximal: "LittleProximal",
  LittleIntermediate: "LittleIntermediate",
  LittleDistal: "LittleDistal",
};

/** Which body parts this frame's landmarks can be trusted to drive. */
export interface PoseGates {
  torso: boolean;
  arms: boolean;
  legs: boolean;
}

/** MediaPipe pose landmark indices. */
const LM = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
};

/** Best visibility of a landmark pair — one visible side is enough to trust the
 * part, and a missing `visibility` field is treated as visible. */
function pairVisibility(
  landmarks: { visibility?: number }[] | undefined,
  a: number,
  b: number
): number {
  if (!landmarks) return 0;
  const va = landmarks[a] ? landmarks[a].visibility ?? 1 : 0;
  const vb = landmarks[b] ? landmarks[b].visibility ?? 1 : 0;
  return Math.max(va, vb);
}

/**
 * Decides per part instead of all-or-nothing.
 *
 * This used to be a single early return on hip visibility, which silently froze
 * the ARMS too: in the face+hands framing the user is close to the camera, the
 * hips are out of shot, and so nothing below the neck ever moved even though the
 * shoulders and elbows were tracked perfectly. Gate each part on the landmarks
 * that part actually needs.
 */
export function resolvePoseGates(
  landmarks: { visibility?: number }[] | undefined,
  mode: "full" | "upper"
): PoseGates {
  const shoulders = pairVisibility(landmarks, LM.leftShoulder, LM.rightShoulder);
  const hips = pairVisibility(landmarks, LM.leftHip, LM.rightHip);
  const knees = pairVisibility(landmarks, LM.leftKnee, LM.rightKnee);

  return {
    // Hips/spine come from the hip line, so they still need it: without hips
    // Kalidokit's torso estimate wanders and the avatar leans on its own.
    torso: hips >= 0.3,
    arms: shoulders >= 0.5,
    legs: mode === "full" && knees > 0.4,
  };
}

function getNode(vrm: MotionAvatar, boneName: string) {
  if (!vrm.humanoid) return null;
  return (
    vrm.humanoid.getNormalizedBoneNode(boneName as never) ||
    vrm.humanoid.getRawBoneNode(boneName as never)
  );
}

/** Applies a Kalidokit euler rotation to a VRM bone, honoring the rig's own
 * rotationOrder, with a deadzone + slerp smoothing.
 *
 * `flipZ`: Kalidokit's rig was authored for the VRM0-era raw-bone axis
 * convention; on our VRM 1.0 model driven through three-vrm's *normalized*
 * bones, the ROLL (local Z) of the body/limb rotations comes out inverted —
 * so a side-raise (abduction) drives the arm DOWN instead of up. Empirically
 * (see the ?debug axis sweep) only Z is inverted: X (pitch, forward/back raise)
 * and Y (yaw/twist) map correctly, and negating them re-breaks the pitch. So we
 * flip only Z on pose- and hand-derived bones. Face/head rotations use a
 * different (Face.solve) convention and are left untouched. */
export function rigRotation(
  vrm: MotionAvatar,
  boneName: string,
  rot: Rot | undefined,
  dampener = 1,
  lerp = LERP_BODY,
  flipZ = false
) {
  if (!rot) return;
  const node = getNode(vrm, boneName);
  if (!node) return;
  const euler = new THREE.Euler(
    rot.x * dampener,
    rot.y * dampener,
    rot.z * dampener * (flipZ ? -1 : 1),
    (rot.rotationOrder as THREE.EulerOrder) || "XYZ"
  );
  const target = new THREE.Quaternion().setFromEuler(euler);
  if (node.quaternion.angleTo(target) > DEADZONE_RAD) {
    node.quaternion.slerp(target, lerp);
  }
}

/**
 * Writes a solved hand rig onto the avatar's wrist + 15 finger joints.
 *
 * `side` is MediaPipe's handedness label, used verbatim for both the solve and
 * the VRM bone prefix — the same same-name convention the pose path uses, which
 * is what produces the intended mirror/selfie behavior.
 */
export function applyHandRig(
  vrm: MotionAvatar,
  handRig: Record<string, Rot> | undefined,
  side: HandSide
) {
  if (!handRig) return;
  const prefix = side.toLowerCase(); // "left" | "right"

  // The wrist rotation lands on the VRM hand bone.
  rigRotation(vrm, `${prefix}Hand`, handRig[`${side}Wrist`], 1, LERP_HAND, true);

  for (const [rigSuffix, boneSuffix] of Object.entries(FINGER_BONE_BY_RIG_SUFFIX)) {
    const rot = handRig[`${side}${rigSuffix}`];
    if (!rot) continue;
    rigRotation(vrm, `${prefix}${boneSuffix}`, rot, 1, LERP_HAND, true);
  }
}
