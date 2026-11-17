// Arm orientation aimed straight at the measured joint positions.
//
// WHY NOT KALIDOKIT: its `rigArm` clamps `UpperArm.x` to [-0.5, PI] and
// `LowerArm.x` to [-0.3, 0.3] and adds a -0.3 offset, so whole families of real
// poses cannot be expressed at all. Bringing a hand up to your own face is one of
// them: the elbow can't fold far enough across the body, so the avatar raises the
// arm out to the SIDE instead and the hand ends up nowhere near the head. No
// amount of tuning downstream fixes a clamp.
//
// Instead: point the upper arm along (elbow - shoulder) and the forearm along
// (wrist - elbow). Two aims, no clamps, and any pose the landmarks can describe is
// reachable. This is forward kinematics from directions rather than IK — we don't
// need to *solve* for a target, we already know where every joint is.
//
// Conventions, matching wristSolver.ts (which was settled on a real device):
//   MediaPipe: x right in the raw frame, y down, z away from the camera.
//   VRM model: +X is the character's own left, +Y up, +Z toward the camera.
//   So camera -> model negates all three axes. That's a reflection, which is
//   correct precisely because it feeds the MIRRORED limb (see the crossing below).

import * as THREE from "three";
import type { MotionAvatar } from "./motionAvatar";
import { applyWorldRotation, LERP_BODY, type VrmSide } from "./boneRig.ts";

/** MediaPipe pose landmark indices. */
const POSE = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
};

interface Point {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/**
 * Which MediaPipe side drives which avatar arm.
 *
 * Crossed, like every other limb here: the avatar reads as a mirror, so its right
 * arm is driven by the user's left. Kalidokit's pose solver already crosses
 * internally, which is why the rest of the bridge maps same-name; this solver
 * reads raw landmarks, so it has to cross explicitly.
 */
function landmarksForSide(side: VrmSide) {
  return side === "right"
    ? { shoulder: POSE.leftShoulder, elbow: POSE.leftElbow, wrist: POSE.leftWrist }
    : { shoulder: POSE.rightShoulder, elbow: POSE.rightElbow, wrist: POSE.rightWrist };
}

/**
 * The direction an arm bone points in the avatar's REST pose.
 *
 * Measured, not assumed (scratch/probe_vrm_axes.mjs): the character's left is
 * world +X, so a T-posed left arm runs along +X and the right along -X. Getting
 * this backwards was a real latent bug once — the FBX front-facing check assumed
 * -X.
 */
function restDirection(side: VrmSide): THREE.Vector3 {
  return new THREE.Vector3(side === "left" ? 1 : -1, 0, 0);
}

/** Camera-space delta -> model-space direction. Every axis flips; see the header. */
function toModelDirection(from: Point, to: Point): THREE.Vector3 {
  return new THREE.Vector3(-(to.x - from.x), -(to.y - from.y), -(to.z - from.z));
}

export interface ArmAim {
  upperArm: THREE.Quaternion;
  lowerArm: THREE.Quaternion;
}

/**
 * World-space rotations for one arm, or null when the landmarks can't support it.
 *
 * Feed this the METRIC world landmarks. Directions in normalized landmark space
 * are skewed — x is divided by the frame width and y by its height — so on a 4:3
 * frame a raised arm reads as a different angle than it is. The same reasoning as
 * the finger solver, and here it changes a direction rather than a magnitude, so
 * it matters more.
 */
export function solveArmAim(
  worldLandmarks: Point[] | undefined,
  normalizedLandmarks: Point[] | undefined,
  side: VrmSide,
  minVisibility = 0.5
): ArmAim | null {
  if (!worldLandmarks || worldLandmarks.length <= POSE.rightWrist) return null;
  const idx = landmarksForSide(side);
  const shoulder = worldLandmarks[idx.shoulder];
  const elbow = worldLandmarks[idx.elbow];
  const wrist = worldLandmarks[idx.wrist];
  if (!shoulder || !elbow || !wrist) return null;

  // Visibility lives on the normalized list; MediaPipe often leaves it at 0 on the
  // world one (the same trap withLandmarkVisibility exists for). An unseen elbow
  // gets *estimated* by the model, and driving a bone from an estimate is how the
  // avatar ends up flailing, so bail and let the previous pose stand.
  const vis = normalizedLandmarks ?? worldLandmarks;
  for (const i of [idx.shoulder, idx.elbow, idx.wrist]) {
    if ((vis[i]?.visibility ?? 1) < minVisibility) return null;
  }

  const upperDir = toModelDirection(shoulder, elbow);
  const lowerDir = toModelDirection(elbow, wrist);
  if (upperDir.lengthSq() < 1e-8 || lowerDir.lengthSq() < 1e-8) return null;
  upperDir.normalize();
  lowerDir.normalize();

  const rest = restDirection(side);
  // Normalized humanoid bones sit at identity in the canonical T-pose, so the
  // minimal rotation taking the rest direction to the aim direction IS the bone's
  // world rotation. tests/realAvatarArms.test.ts checks the resulting hand
  // POSITION on the real avatar, so this holds up or the test says so.
  return {
    upperArm: new THREE.Quaternion().setFromUnitVectors(rest, upperDir),
    lowerArm: new THREE.Quaternion().setFromUnitVectors(rest, lowerDir),
  };
}

/** Writes a solved arm onto the avatar. */
export function applyArmAim(vrm: MotionAvatar, side: VrmSide, aim: ArmAim, lerp = LERP_BODY): void {
  applyWorldRotation(vrm, `${side}UpperArm`, aim.upperArm, lerp);
  // The forearm's world rotation is converted through the upper arm's CURRENT
  // world rotation, so the upper arm has to be written first.
  applyWorldRotation(vrm, `${side}LowerArm`, aim.lowerArm, lerp);
}
