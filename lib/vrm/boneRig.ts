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

/**
 * Extra curl applied to every finger joint before it reaches the bone.
 *
 * The joint angles come out of an ESTIMATED 3D hand, and depth is the weakest
 * part of that estimate, so a closing hand — whose motion is mostly along the
 * view axis — tends to read shallower than it is. Scaling the curl (and
 * re-clamping to the side's valid half range) buys some of that back. It's
 * linear, so a relaxed hand at 0.05 rad only gains a degree; a fist is where it
 * shows.
 *
 * Kept modest on purpose: it is compensation for a known bias, not a fix for
 * anything. If fists look OVER-curled, lower it towards 1.0; if a real fist still
 * reads as half-closed, this is the knob to raise.
 */
export const FINGER_CURL_GAIN = 1.15;

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
    // Already gained and clamped by solveFingerRig; write it straight through.
    rigRotation(vrm, `${vrmSide}${boneSuffix}`, rot, 1, LERP_HAND, false);
  }
}

/**
 * Scales a finger joint's curl, staying inside the side's valid half-range.
 *
 * The range is one-sided on purpose: a finger bends towards the palm and not the
 * other way, so Kalidokit clamps a right hand's curl to [-PI, 0] and a left
 * hand's to [0, PI]. Clamping to the same interval keeps the gain from ever
 * pushing a joint through a sign change into a backwards bend.
 */
export function boostCurl(rot: Rot, solveSide: HandSide, gain = FINGER_CURL_GAIN): Rot {
  const scaled = rot.z * gain;
  return {
    ...rot,
    z:
      solveSide === "Right"
        ? THREE.MathUtils.clamp(scaled, -Math.PI, 0)
        : THREE.MathUtils.clamp(scaled, 0, Math.PI),
  };
}

interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** The landmark triple whose middle point is each joint. Same joints Kalidokit
 * measures, including the wrist standing in as the reference for every knuckle. */
export const FINGER_JOINT_LANDMARKS: Record<string, [number, number, number]> = {
  ThumbProximal: [0, 1, 2],
  ThumbIntermediate: [1, 2, 3],
  ThumbDistal: [2, 3, 4],
  IndexProximal: [0, 5, 6],
  IndexIntermediate: [5, 6, 7],
  IndexDistal: [6, 7, 8],
  MiddleProximal: [0, 9, 10],
  MiddleIntermediate: [9, 10, 11],
  MiddleDistal: [10, 11, 12],
  RingProximal: [0, 13, 14],
  RingIntermediate: [13, 14, 15],
  RingDistal: [14, 15, 16],
  LittleProximal: [0, 17, 18],
  LittleIntermediate: [17, 18, 19],
  LittleDistal: [18, 19, 20],
};

/** The thumb's usable range is much smaller than a finger's. */
const THUMB_DAMPING = 0.7;

/**
 * How far each joint in a chain can actually flex, in radians (~92, 109, 80
 * degrees). Roughly human MCP/PIP/DIP limits.
 *
 * This is a guard, not styling. Now that flexion is measured without folding
 * (see jointFlexion), a joint whose neighbours land almost on top of each other
 * measures an interior angle near zero — i.e. 180 degrees of flexion, a finger
 * bent double. Estimated depth makes that reachable on a bad frame, and it looks
 * far worse than being slightly under-curled. The fold used to hide this by
 * mapping big angles back down; capping at the anatomical limit does the same job
 * without lying about the middle of the range.
 */
const MAX_FLEXION_BY_SEGMENT: Record<string, number> = {
  Proximal: 1.6,
  Intermediate: 1.9,
  Distal: 1.4,
};

/**
 * Flexion of the joint at `b`, in radians: 0 straight, PI/2 at a right angle,
 * rising all the way to PI.
 *
 * This deliberately does NOT use Kalidokit's `normalizeRadians`, which folds
 * anything past a right angle back down — it reports 100 degrees of flexion as
 * 80, and 120 as 60. The measure peaks at 90 degrees and then runs BACKWARDS, so
 * squeezing a fist tighter made the avatar's fingers straighten out. A tight
 * fist's middle joints reach 100-120 degrees, and the thumb folds furthest of
 * all, which is why the thumb looked worst. Flexion is just PI minus the interior
 * angle, monotonic over the whole range.
 */
export function jointFlexion(a: Point3, b: Point3, c: Point3): number {
  const v1 = new THREE.Vector3(a.x - b.x, a.y - b.y, a.z - b.z);
  const v2 = new THREE.Vector3(c.x - b.x, c.y - b.y, c.z - b.z);
  if (v1.lengthSq() < 1e-12 || v2.lengthSq() < 1e-12) return 0;
  const interior = Math.acos(THREE.MathUtils.clamp(v1.normalize().dot(v2.normalize()), -1, 1));
  return Math.PI - interior;
}

/**
 * All 15 finger joint rotations, replacing Kalidokit's hand solver.
 *
 * Two reasons this is ours rather than the package's:
 *
 * 1. Its joint measure folds past 90 degrees (see jointFlexion), so a closing
 *    fist starts opening again.
 * 2. Its thumb branch is a pile of constants tuned for VRM0's bone naming —
 *    `startPos.x` alone is 1.2 rad (69 degrees). VRM 1.0 shifted the thumb chain
 *    by one joint (Metacarpal/Proximal/Distal), so those offsets land on the
 *    wrong joint and bend the thumb off on its own regardless of the real hand.
 *
 * Measured on the real avatar (scratch/probe_vrm_axes.mjs): every digit, thumb
 * included, curls palmward on -Z (left) / +Z (right). So one formula covers all
 * five, with no constant offsets — only the thumb's smaller range is damped.
 *
 * Feed this the METRIC (world) landmarks; see applyHand in kalidokitBridge.ts for
 * why the normalized ones lose the curl. Keys are rig-side names, which
 * FINGER_BONE_BY_RIG_SUFFIX shifts onto the VRM joints.
 */
export function solveFingerRig(
  landmarks: Point3[] | undefined,
  solveSide: HandSide
): Record<string, Rot> {
  const out: Record<string, Rot> = {};
  if (!landmarks || landmarks.length < 21) return out;

  const invert = solveSide === "Right" ? 1 : -1;
  for (const [rigSuffix, [a, b, c]] of Object.entries(FINGER_JOINT_LANDMARKS)) {
    const isThumb = rigSuffix.startsWith("Thumb");
    const damping = isThumb ? THUMB_DAMPING : 1;
    const segment = rigSuffix.replace(/^(Thumb|Index|Middle|Ring|Little)/, "");
    const limit = MAX_FLEXION_BY_SEGMENT[segment] ?? Math.PI;
    const flexion = Math.min(
      jointFlexion(landmarks[a], landmarks[b], landmarks[c]) * FINGER_CURL_GAIN * damping,
      limit
    );

    if (isThumb) {
      // ⚠️ THE THUMB TURNS ON A DIFFERENT AXIS FROM THE OTHER FOUR — measured, and
      // it used to be wrong. Driving the thumb on Z like a finger moves its tip
      // AWAY from the knuckles (scratch/probe_thumb_axis.mjs: the gap to
      // middleProximal opens by 0.02-0.04 on either Z sign), which on a real
      // device reads exactly as "the thumb bends backwards".
      //
      // A thumb doesn't fold perpendicular to the palm the way a finger does; it
      // folds ACROSS the palm toward the little finger. On this rig that is local
      // Y, mirrored per side: the avatar's left thumb on +Y and its right on -Y
      // both close the gap to the knuckle by 0.028. Note the per-side pattern is
      // the OPPOSITE of the fingers' (left -Z / right +Z), which is why one shared
      // `invert` can't cover both.
      out[`${solveSide}${rigSuffix}`] = { x: 0, y: flexion * invert, z: 0 };
      continue;
    }

    // boostCurl clamps to the side's valid half-range too, so a joint can never
    // come out bent the wrong way. The gain is already applied above.
    out[`${solveSide}${rigSuffix}`] = boostCurl({ x: 0, y: 0, z: -flexion * invert }, solveSide, 1);
  }
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
