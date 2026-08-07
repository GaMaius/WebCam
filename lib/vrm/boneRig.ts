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

/** MediaPipe's handedness label — the ANATOMICAL hand, which is what Kalidokit's
 * solver needs to pick its palm points and clamp ranges. */
export type HandSide = "Left" | "Right";

/** Which of the avatar's hands a solved rig is written to. Note this is the
 * OPPOSITE of the anatomical side: Kalidokit's pose solver crosses sides (its
 * `RightUpperArm` is built from MediaPipe's LEFT shoulder/elbow), so everything
 * on the avatar's right is driven by the user's left, which is what makes the
 * avatar read as a mirror. The hand path has to cross the same way or each hand
 * ends up on the other arm — invisible while both hands do the same thing, but it
 * shows up as a badly wrong wrist angle. */
export type VrmSide = "left" | "right";

/** The avatar side a given anatomical hand belongs on, mirrored. */
export function vrmSideForHand(solveSide: HandSide): VrmSide {
  return solveSide === "Left" ? "right" : "left";
}

/** The pose rig key carrying that same limb's hand rotation. Kalidokit's
 * crossing means the user's LEFT hand appears as `RightHand`. */
export function poseHandKeyForHand(solveSide: HandSide): "LeftHand" | "RightHand" {
  return solveSide === "Left" ? "RightHand" : "LeftHand";
}

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

/** Face rotations need BOTH pitch and roll negated.
 *
 * Kalidokit's head rotation is authored for VRM0 raw bones, and VRM0 vs VRM1 is a
 * 180-degree turn about Y — conjugating a rotation by that turn negates its X and
 * Z components. Roll was fixed first (head tilt went the wrong way); pitch turned
 * out to be inverted too (looking down made the avatar look up). Yaw (Y) is the
 * one component that survives the turn, so it is left alone. */
export function rigFaceRotation(
  vrm: MotionAvatar,
  boneName: string,
  rot: Rot | undefined,
  dampener = 1,
  lerp = LERP_FACE
) {
  if (!rot) return;
  rigRotation(vrm, boneName, { ...rot, x: -rot.x }, dampener, lerp, true);
}

/**
 * Writes a solved hand rig onto the avatar's wrist + 15 finger joints.
 *
 * `side` is MediaPipe's handedness label, used verbatim for both the solve and
 * the VRM bone prefix — the same same-name convention the pose path uses, which
 * is what produces the intended mirror/selfie behavior.
 *
 * `poseHandRoll` is `Pose.solve`'s `{side}Hand.z`. The wrist is deliberately
 * built from two sources: FLEX/DEVIATION (x/y) from the palm landmarks, and ROLL
 * (z, i.e. forearm twist) from the arm chain. Kalidokit's hand solver derives its
 * own roll from the palm plane and then folds it into yaw as well
 * (`handRotation.y = handRotation.z`), so applying its full wrist rotation snaps
 * the hand to a broken-looking angle — the forearm's own twist is the reliable
 * source for roll.
 */
export function applyHandRig(
  vrm: MotionAvatar,
  handRig: Record<string, Rot> | undefined,
  solveSide: HandSide,
  vrmSide: VrmSide,
  wristWorld?: THREE.Quaternion | null
) {
  if (!handRig) return;

  // The wrist is driven by lib/vrm/wristSolver.ts, not by Kalidokit: its wrist
  // rotation twists the hand off the forearm (it copies roll into yaw), and
  // taking roll from the arm chain instead loses palm rotation altogether.
  if (wristWorld) applyWorldRotation(vrm, `${vrmSide}Hand`, wristWorld, LERP_HAND);

  for (const [rigSuffix, boneSuffix] of Object.entries(FINGER_BONE_BY_RIG_SUFFIX)) {
    const rot = handRig[`${solveSide}${rigSuffix}`];
    if (!rot) continue;
    // No flipZ: crossing the sides already lands the correct sign. Kalidokit
    // emits a left-hand curl as +z (rigFingers clamps to [0,PI]) and the avatar's
    // RIGHT hand — which is where a left hand belongs in a mirror — curls on +z
    // too (measured, scratch/probe_vrm_axes.mjs). Uncrossed, this needed a flip.
    rigRotation(vrm, `${vrmSide}${boneSuffix}`, rot, 1, LERP_HAND, false);
  }
}

/** Thumb landmark triples: the joint being bent, with its neighbours. */
const THUMB_JOINTS: [number, number, number][] = [
  [0, 1, 2], // metacarpal
  [1, 2, 3], // proximal
  [2, 3, 4], // distal
];
/** The thumb's usable range is much smaller than a finger's. */
const THUMB_GAIN = 0.7;

/** Kalidokit's `normalizeRadians`, ported so the thumb can use the same joint
 * measure as the fingers without reaching into the package's internals: ~0 for a
 * straight joint, ~0.5 at 90 degrees. */
function normalizeRadians(radians: number): number {
  let r = radians;
  if (r >= Math.PI / 2) r -= 2 * Math.PI;
  if (r <= -Math.PI / 2) {
    r += 2 * Math.PI;
    r = Math.PI - r;
  }
  return r / Math.PI;
}

/** Normalized bend of the joint at `b`, between neighbours `a` and `c`. */
function jointBend(a: Point3, b: Point3, c: Point3): number {
  const v1 = new THREE.Vector3(a.x - b.x, a.y - b.y, a.z - b.z);
  const v2 = new THREE.Vector3(c.x - b.x, c.y - b.y, c.z - b.z);
  if (v1.lengthSq() < 1e-12 || v2.lengthSq() < 1e-12) return 0;
  const dot = THREE.MathUtils.clamp(v1.normalize().dot(v2.normalize()), -1, 1);
  return normalizeRadians(Math.acos(dot));
}

interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Thumb rotations, replacing Kalidokit's thumb output.
 *
 * Kalidokit's thumb is a special case full of constants tuned for VRM0's bone
 * naming — `startPos.x` alone is 1.2 rad (69 degrees). VRM 1.0 shifted the thumb
 * chain by one joint (Metacarpal/Proximal/Distal), so those offsets land on the
 * wrong joint and bend the thumb off on its own regardless of the real hand.
 *
 * Measured on the real avatar (scratch/probe_vrm_axes.mjs): the thumb curls
 * palmward on -Z (left) / +Z (right), the same axis and signs as the other
 * fingers, so it gets their formula and no constant offsets.
 *
 * Keys are rig-side names, which FINGER_BONE_BY_RIG_SUFFIX shifts onto the VRM
 * joints.
 */
export function solveThumbRig(
  landmarks: Point3[] | undefined,
  solveSide: HandSide
): Record<string, Rot> {
  const out: Record<string, Rot> = {};
  if (!landmarks || landmarks.length < 5) return out;

  const invert = solveSide === "Right" ? 1 : -1;
  const rigKeys = ["ThumbProximal", "ThumbIntermediate", "ThumbDistal"];

  THUMB_JOINTS.forEach(([a, b, c], i) => {
    const bend = jointBend(landmarks[a], landmarks[b], landmarks[c]);
    const z = bend * -Math.PI * invert * THUMB_GAIN;
    out[`${solveSide}${rigKeys[i]}`] = {
      x: 0,
      y: 0,
      // Clamp to the side's anatomically valid half-range, as Kalidokit does for
      // the other four fingers.
      z: invert > 0 ? THREE.MathUtils.clamp(z, -Math.PI, 0) : THREE.MathUtils.clamp(z, 0, Math.PI),
    };
  });
  return out;
}

/** Sets a bone's rotation from a WORLD-space target, converting through the
 * parent's current world rotation. Used for the wrist, whose orientation is
 * solved in model space rather than as a parent-relative euler. */
export function applyWorldRotation(
  vrm: MotionAvatar,
  boneName: string,
  world: THREE.Quaternion,
  lerp = LERP_HAND
) {
  const node = getNode(vrm, boneName);
  if (!node) return;

  let target = world;
  if (node.parent) {
    // Matrices are only refreshed at render time, so the parent chain (which the
    // arm bones may have just changed) has to be brought up to date first.
    node.parent.updateWorldMatrix(true, false);
    const parentWorld = new THREE.Quaternion();
    node.parent.getWorldQuaternion(parentWorld);
    target = parentWorld.invert().multiply(world);
  }

  if (node.quaternion.angleTo(target) > DEADZONE_RAD) {
    node.quaternion.slerp(target, lerp);
  }
}

/**
 * Copies `visibility` from the normalized landmarks onto the world landmarks.
 *
 * Kalidokit decides a hand is "offscreen" when the wrist's world-landmark
 * visibility is under 0.23, and in that case it throws the arm away and
 * substitutes a resting default. MediaPipe does not reliably populate visibility
 * on world landmarks (it's often 0 there while the normalized list has real
 * values), so without this the arms sit in a resting pose no matter what the
 * user does — which is exactly what happened on device.
 */
export function withLandmarkVisibility<T extends { x: number; y: number; z: number }>(
  world: T[] | undefined,
  normalized: { visibility?: number }[] | undefined
): (T & { visibility?: number })[] | undefined {
  if (!world) return undefined;
  if (!normalized) return world as (T & { visibility?: number })[];
  return world.map((point, i) => {
    const existing = (point as { visibility?: number }).visibility ?? 0;
    const fromNormalized = normalized[i]?.visibility ?? 0;
    return { ...point, visibility: Math.max(existing, fromNormalized) };
  });
}
