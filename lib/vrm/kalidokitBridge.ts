import * as Kalidokit from "kalidokit";
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

export interface LandmarkFrameData {
  poseLandmarks?: NormalizedLandmark[];
  poseWorldLandmarks?: { x: number; y: number; z: number; visibility?: number }[];
  faceLandmarks?: NormalizedLandmark[];
  leftHandLandmarks?: NormalizedLandmark[];
  rightHandLandmarks?: NormalizedLandmark[];
}

// Exposed for the dev-only ?debug harness so calibration/axis probes can call
// the solver directly. Not used by the app at runtime.
export const _KalidokitForDebug = Kalidokit;

// three-vrm's normalized humanoid abstracts away VRM0/VRM1 differences, so
// Kalidokit's rig output maps DIRECTLY onto the normalized bones — same-named
// bone, no left/right swap, no axis sign-flips. (The previous implementation
// stacked a manual L/R swap AND per-axis negation on top of each other, which
// is what made the avatar move in the opposite/mirrored-wrong direction.)
// Kalidokit already produces a mirror-like result (the avatar acts as your
// reflection), which is the intended selfie/VTuber UX.

function getNode(vrm: VRM, boneName: any) {
  if (!vrm.humanoid) return null;
  return vrm.humanoid.getNormalizedBoneNode(boneName) || vrm.humanoid.getRawBoneNode(boneName);
}

// Smoothing + deadzone to kill micro-jitter while keeping response snappy.
const DEADZONE_RAD = 0.02; // ~1.1° — ignore sub-threshold jitter
const LERP_BODY = 0.3;
const LERP_LEG = 0.22; // extra damping so legs don't pop
const LERP_FACE = 0.3;

type Rot = { x: number; y: number; z: number; rotationOrder?: string };

/** Applies a Kalidokit euler rotation to a VRM bone, honoring the rig's own
 * rotationOrder, with a deadzone + slerp smoothing.
 *
 * `flipZ`: Kalidokit's rig was authored for the VRM0-era raw-bone axis
 * convention; on our VRM 1.0 model driven through three-vrm's *normalized*
 * bones, the ROLL (local Z) of the body/limb rotations comes out inverted —
 * so a side-raise (abduction) drives the arm DOWN instead of up. Empirically
 * (see the ?debug axis sweep) only Z is inverted: X (pitch, forward/back raise)
 * and Y (yaw/twist) map correctly, and negating them re-breaks the pitch. So we
 * flip only Z on pose-derived bones. Face/head rotations use a different
 * (Face.solve) convention and are left untouched. */
function rigRotation(
  vrm: VRM,
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

export function applyTrackingToVRM(vrm: VRM, frame: LandmarkFrameData) {
  if (!vrm) return;

  // 1. Face — head/neck rotation + blink/mouth expressions.
  if (frame.faceLandmarks && frame.faceLandmarks.length > 0) {
    const faceRig = Kalidokit.Face.solve(frame.faceLandmarks, {
      runtime: "mediapipe",
      smoothBlink: true,
    });

    if (faceRig) {
      rigRotation(vrm, "head", faceRig.head as Rot, 1, LERP_FACE);
      rigRotation(vrm, "neck", faceRig.head as Rot, 0.4, LERP_FACE);

      if (vrm.expressionManager) {
        const blinkLeft = clampThreshold(1 - faceRig.eye.l, 0.15, 0.85);
        const blinkRight = clampThreshold(1 - faceRig.eye.r, 0.15, 0.85);
        vrm.expressionManager.setValue("blinkLeft", blinkLeft);
        vrm.expressionManager.setValue("blinkRight", blinkRight);

        if (faceRig.mouth && faceRig.mouth.shape) {
          vrm.expressionManager.setValue("aa", cutoff(faceRig.mouth.shape.A, 0.08));
          vrm.expressionManager.setValue("ih", cutoff(faceRig.mouth.shape.I, 0.08));
          vrm.expressionManager.setValue("ou", cutoff(faceRig.mouth.shape.U, 0.08));
          vrm.expressionManager.setValue("ee", cutoff(faceRig.mouth.shape.E, 0.08));
          vrm.expressionManager.setValue("oh", cutoff(faceRig.mouth.shape.O, 0.08));
        }
      }
    }
  }

  // 2. Pose — torso, arms, legs. Same-name mapping (no L/R swap: Kalidokit
  // already crosses MediaPipe's sides to produce the mirror/selfie result),
  // with ROLL (Z) inverted for the VRM1 normalized-bone convention.
  if (frame.poseWorldLandmarks && frame.poseWorldLandmarks.length > 20 && frame.poseLandmarks) {
    // Skip when the hips are hidden/unreliable to avoid ghost motion.
    const hipLandmark = frame.poseLandmarks[23] || frame.poseLandmarks[24];
    if (hipLandmark && (hipLandmark.visibility ?? 1) < 0.3) return;

    const poseRig = Kalidokit.Pose.solve(frame.poseWorldLandmarks, frame.poseLandmarks, {
      runtime: "mediapipe",
      enableLegs: true,
    });

    if (poseRig) {
      rigRotation(vrm, "hips", poseRig.Hips?.rotation as Rot, 0.7, LERP_BODY, true);
      rigRotation(vrm, "spine", poseRig.Spine as Rot, 0.45, LERP_BODY, true);
      rigRotation(vrm, "chest", poseRig.Spine as Rot, 0.25, LERP_BODY, true);

      rigRotation(vrm, "rightUpperArm", poseRig.RightUpperArm as Rot, 1, LERP_BODY, true);
      rigRotation(vrm, "rightLowerArm", poseRig.RightLowerArm as Rot, 1, LERP_BODY, true);
      rigRotation(vrm, "leftUpperArm", poseRig.LeftUpperArm as Rot, 1, LERP_BODY, true);
      rigRotation(vrm, "leftLowerArm", poseRig.LeftLowerArm as Rot, 1, LERP_BODY, true);

      const kneeL = frame.poseLandmarks[25];
      const kneeR = frame.poseLandmarks[26];
      const legsVisible = (kneeL?.visibility ?? 1) > 0.4 && (kneeR?.visibility ?? 1) > 0.4;
      if (legsVisible) {
        rigRotation(vrm, "rightUpperLeg", poseRig.RightUpperLeg as Rot, 1, LERP_LEG, true);
        rigRotation(vrm, "rightLowerLeg", poseRig.RightLowerLeg as Rot, 1, LERP_LEG, true);
        rigRotation(vrm, "leftUpperLeg", poseRig.LeftUpperLeg as Rot, 1, LERP_LEG, true);
        rigRotation(vrm, "leftLowerLeg", poseRig.LeftLowerLeg as Rot, 1, LERP_LEG, true);
      }
    }
  }
}

function cutoff(val: number, threshold: number): number {
  return val < threshold ? 0 : val;
}

function clampThreshold(val: number, low: number, high: number): number {
  if (val <= low) return 0;
  if (val >= high) return 1;
  return (val - low) / (high - low);
}
