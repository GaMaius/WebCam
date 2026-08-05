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
 * rotationOrder, with a deadzone + slerp smoothing. */
function rigRotation(
  vrm: VRM,
  boneName: string,
  rot: Rot | undefined,
  dampener = 1,
  lerp = LERP_BODY
) {
  if (!rot) return;
  const node = getNode(vrm, boneName);
  if (!node) return;
  const euler = new THREE.Euler(
    rot.x * dampener,
    rot.y * dampener,
    rot.z * dampener,
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

  // 2. Pose — torso, arms, legs. Direct same-name mapping (no swap/flip).
  if (frame.poseWorldLandmarks && frame.poseWorldLandmarks.length > 20 && frame.poseLandmarks) {
    // Skip when the hips are hidden/unreliable to avoid ghost motion.
    const hipLandmark = frame.poseLandmarks[23] || frame.poseLandmarks[24];
    if (hipLandmark && (hipLandmark.visibility ?? 1) < 0.3) return;

    const poseRig = Kalidokit.Pose.solve(frame.poseWorldLandmarks, frame.poseLandmarks, {
      runtime: "mediapipe",
      enableLegs: true,
    });

    if (poseRig) {
      rigRotation(vrm, "hips", poseRig.Hips?.rotation as Rot, 0.7);
      rigRotation(vrm, "spine", poseRig.Spine as Rot, 0.45);
      rigRotation(vrm, "chest", poseRig.Spine as Rot, 0.25);

      rigRotation(vrm, "rightUpperArm", poseRig.RightUpperArm as Rot, 1);
      rigRotation(vrm, "rightLowerArm", poseRig.RightLowerArm as Rot, 1);
      rigRotation(vrm, "leftUpperArm", poseRig.LeftUpperArm as Rot, 1);
      rigRotation(vrm, "leftLowerArm", poseRig.LeftLowerArm as Rot, 1);

      const kneeL = frame.poseLandmarks[25];
      const kneeR = frame.poseLandmarks[26];
      const legsVisible = (kneeL?.visibility ?? 1) > 0.4 && (kneeR?.visibility ?? 1) > 0.4;
      if (legsVisible) {
        rigRotation(vrm, "rightUpperLeg", poseRig.RightUpperLeg as Rot, 1, LERP_LEG);
        rigRotation(vrm, "rightLowerLeg", poseRig.RightLowerLeg as Rot, 1, LERP_LEG);
        rigRotation(vrm, "leftUpperLeg", poseRig.LeftUpperLeg as Rot, 1, LERP_LEG);
        rigRotation(vrm, "leftLowerLeg", poseRig.LeftLowerLeg as Rot, 1, LERP_LEG);
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
