import * as Kalidokit from "kalidokit";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { MotionAvatar } from "./motionAvatar";
import { vrmExpressionsFromBlendshapes, type BlendshapeCategory } from "./faceExpressions";
import {
  applyHandRig,
  LERP_BODY,
  LERP_FACE,
  LERP_LEG,
  rigRotation,
  type HandSide,
  type Rot,
} from "./boneRig";

export interface LandmarkFrameData {
  poseLandmarks?: NormalizedLandmark[];
  poseWorldLandmarks?: { x: number; y: number; z: number; visibility?: number }[];
  faceLandmarks?: NormalizedLandmark[];
  /** ARKit blendshapes from FaceLandmarker, when enabled. Preferred over
   * Kalidokit's geometric eye/mouth solve. */
  faceBlendshapes?: BlendshapeCategory[];
  leftHandLandmarks?: NormalizedLandmark[];
  rightHandLandmarks?: NormalizedLandmark[];
}

/** "full" drives the whole body; "upper" is the face+hands version — legs are
 * never driven, so a seated user's out-of-frame legs can't twitch. */
export type TrackingMode = "full" | "upper";

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

// Non-VRM rigs (FBX/glTF) are adapted to this same normalized humanoid by
// lib/vrm/humanoidRigger.ts, including a rest-pose fix to T-pose, so everything
// below applies unchanged to them.

// The axis convention (and the flipZ rationale) plus the finger-name mapping
// live in ./boneRig, which is importable without Kalidokit so they stay
// unit-testable.

export function applyTrackingToVRM(
  vrm: MotionAvatar,
  frame: LandmarkFrameData,
  mode: TrackingMode = "full"
) {
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
        // Prefer ARKit blendshapes; they're steadier and cover brows/gaze that
        // Kalidokit doesn't solve at all.
        if (frame.faceBlendshapes && frame.faceBlendshapes.length > 0) {
          const weights = vrmExpressionsFromBlendshapes(frame.faceBlendshapes);
          for (const [name, value] of Object.entries(weights)) {
            vrm.expressionManager.setValue(name, value);
          }
        } else {
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
  }

  // 1b. Hands — wrist + 15 finger joints per side.
  applyHand(vrm, frame.leftHandLandmarks, "Left");
  applyHand(vrm, frame.rightHandLandmarks, "Right");

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
      if (mode === "full" && legsVisible) {
        rigRotation(vrm, "rightUpperLeg", poseRig.RightUpperLeg as Rot, 1, LERP_LEG, true);
        rigRotation(vrm, "rightLowerLeg", poseRig.RightLowerLeg as Rot, 1, LERP_LEG, true);
        rigRotation(vrm, "leftUpperLeg", poseRig.LeftUpperLeg as Rot, 1, LERP_LEG, true);
        rigRotation(vrm, "leftLowerLeg", poseRig.LeftLowerLeg as Rot, 1, LERP_LEG, true);
      }
    }
  }
}

/** Solves one hand from MediaPipe landmarks and writes it to the avatar. */
function applyHand(
  vrm: MotionAvatar,
  landmarks: NormalizedLandmark[] | undefined,
  side: HandSide
) {
  if (!landmarks || landmarks.length < 21) return;
  const handRig = Kalidokit.Hand.solve(landmarks as never, side) as
    | Record<string, Rot>
    | undefined;
  applyHandRig(vrm, handRig, side);
}

function cutoff(val: number, threshold: number): number {
  return val < threshold ? 0 : val;
}

function clampThreshold(val: number, low: number, high: number): number {
  if (val <= low) return 0;
  if (val >= high) return 1;
  return (val - low) / (high - low);
}
