// Wrist orientation solved straight from the hand landmarks.
//
// Kalidokit's hand solver can't do this job: it derives a roll from the palm
// plane and then copies that same number into yaw (`handRotation.y =
// handRotation.z`, plus a -0.4 bias), so its wrist rotation twists the hand off
// its forearm. Taking roll from the pose chain instead avoids the twist but
// loses palm rotation entirely — turning your wrist did nothing. So build the
// orientation from the palm's own geometry.
//
// SPEC (what "correct" means here — asserted in tests/realAvatarHands.test.ts):
//   - palm toward the camera + fingers up  -> avatar palm faces +Z, fingers +Y
//   - rotating the real wrist              -> avatar hand orientation changes
//
// Conventions, all measured rather than assumed (scratch/probe_vrm_axes.mjs):
//   MediaPipe landmarks: x right in the RAW frame, y down, z away from camera.
//   VRM model space:     +X is the character's own left, +Y up, +Z toward camera.
//   VRM hand at rest:    fingers along +X (left) / -X (right), palm -Y,
//                        index->little pointing -Z on both hands.

import * as THREE from "three";
import type { VrmSide } from "./boneRig";

/** MediaPipe hand landmark indices. */
const WRIST = 0;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;

interface Point {
  x: number;
  y: number;
  z: number;
}

/**
 * Camera-space direction -> model-space direction.
 *
 * Every axis flips. The display is mirrored, so a direction that runs toward the
 * raw frame's +x appears on the viewer's left, which is model -X; y is flipped
 * because image y runs down; z because MediaPipe measures depth away from the
 * camera while the model's +Z faces it. The result is a reflection rather than a
 * rotation, which is exactly right when the target is the MIRRORED limb.
 */
function toModelSpace(from: Point, to: Point): THREE.Vector3 {
  return new THREE.Vector3(
    -(to.x - from.x),
    -(to.y - from.y),
    -DEPTH_SIGN * (to.z - from.z)
  );
}

/** +1 means MediaPipe's landmark z grows AWAY from the camera, which is what its
 * docs describe ("smaller z is closer"). The x and y directions are pinned by
 * observable behavior — fingers up must read as up, and the mirrored crossing
 * fixes x — but depth only shows up as the palm's facing direction. If palms come
 * out facing backwards on a real device, this is the one value to flip. */
const DEPTH_SIGN = 1;

/** Palm-normal sign for the side's cross product: for the avatar's LEFT hand
 * `fingers x (index->little)` points at the BACK of the hand, and for the RIGHT
 * hand it points at the palm — the two hands are mirror images, so the cross
 * flips. (Measured; deriving it once "generically" is how this went wrong.) */
function palmSign(side: VrmSide): number {
  return side === "left" ? -1 : 1;
}

/** Orthonormal basis (fingers, palm, third) as a rotation matrix. */
function basis(fingers: THREE.Vector3, palm: THREE.Vector3): THREE.Matrix4 {
  const third = new THREE.Vector3().crossVectors(fingers, palm);
  return new THREE.Matrix4().makeBasis(fingers, palm, third);
}

/** The hand's rest basis in the normalized rig, where rest rotations are identity
 * so the anatomical rest axes are the world axes. */
function restBasis(side: VrmSide): THREE.Matrix4 {
  const fingers = new THREE.Vector3(side === "left" ? 1 : -1, 0, 0);
  const palm = new THREE.Vector3(0, -1, 0);
  return basis(fingers, palm);
}

/**
 * World-space orientation for the avatar's hand bone, or null when the landmarks
 * are too degenerate to define a basis.
 *
 * `side` is the AVATAR's hand (already mirrored from MediaPipe's handedness).
 */
export function solveWristWorldQuaternion(
  landmarks: Point[] | undefined,
  side: VrmSide
): THREE.Quaternion | null {
  if (!landmarks || landmarks.length <= PINKY_MCP) return null;

  const wrist = landmarks[WRIST];
  const indexMcp = landmarks[INDEX_MCP];
  const middleMcp = landmarks[MIDDLE_MCP];
  const pinkyMcp = landmarks[PINKY_MCP];
  if (!wrist || !indexMcp || !middleMcp || !pinkyMcp) return null;

  const fingers = toModelSpace(wrist, middleMcp);
  const across = toModelSpace(indexMcp, pinkyMcp);
  if (fingers.lengthSq() < 1e-9 || across.lengthSq() < 1e-9) return null;
  fingers.normalize();
  across.normalize();

  const palm = new THREE.Vector3()
    .crossVectors(fingers, across)
    .multiplyScalar(palmSign(side));
  if (palm.lengthSq() < 1e-6) return null; // fingers and palm axis collinear
  palm.normalize();
  // Re-orthogonalize: the landmarks are noisy and `across` is never exactly
  // perpendicular to the finger direction.
  fingers.sub(palm.clone().multiplyScalar(fingers.dot(palm))).normalize();

  const observed = basis(fingers, palm);
  const rest = restBasis(side);

  // R = observed * rest^-1. Both are pure rotations, so the inverse is the
  // transpose.
  const rotation = observed.multiply(rest.transpose());
  return new THREE.Quaternion().setFromRotationMatrix(rotation);
}
