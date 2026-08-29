import * as Kalidokit from "kalidokit";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { MotionAvatar } from "./motionAvatar";
import { vrmExpressionsFromBlendshapes, type BlendshapeCategory } from "./faceExpressions";
import { solveWristWorldQuaternion } from "./wristSolver";
import { solveArmAim, applyArmAim } from "./armSolver";
import {
  applyHandRig,
  LERP_BODY,
  LERP_FACE,
  LERP_LEG,
  resolvePoseGates,
  rigFaceRotation,
  rigRotation,
  solveFingerRig,
  vrmSideForHand,
  withLandmarkVisibility,
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
  /** HandLandmarker's METRIC hand landmarks (meters, origin at the hand's
   * centre). Finger joint angles are measured off these — see applyHand. */
  leftHandWorldLandmarks?: { x: number; y: number; z: number }[];
  rightHandWorldLandmarks?: { x: number; y: number; z: number }[];
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
      // Head ROLL (the "tilt") is inverted here for the same reason the body's
      // is: Kalidokit's rotations are VRM0 raw-bone convention and we drive
      // three-vrm's normalized bones. Tilting your head right used to tilt the
      // avatar's left. So the head flips Z too — every solver-derived bone in
      // this file now does, which is one rule instead of an exception.
      rigFaceRotation(vrm, "head", faceRig.head as Rot, 1, LERP_FACE);
      rigFaceRotation(vrm, "neck", faceRig.head as Rot, 0.4, LERP_FACE);

      if (vrm.expressionManager) {
        // Prefer ARKit blendshapes; they're steadier and cover brows/gaze that
        // Kalidokit doesn't solve at all.
        if (frame.faceBlendshapes && frame.faceBlendshapes.length > 0) {
          const weights = vrmExpressionsFromBlendshapes(frame.faceBlendshapes);
          for (const [name, value] of Object.entries(weights)) {
            vrm.expressionManager.setValue(name, value);
          }
        } else {
          // Mirrored, like the blendshape path: your left eye drives the eye on
          // your side of the screen, which is the avatar's right.
          const blinkLeft = clampThreshold(1 - faceRig.eye.r, 0.15, 0.85);
          const blinkRight = clampThreshold(1 - faceRig.eye.l, 0.15, 0.85);
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

  // 2. Pose — torso, arms, legs. Same-name mapping (no L/R swap: Kalidokit
  // already crosses MediaPipe's sides to produce the mirror/selfie result),
  // with ROLL (Z) inverted for the VRM1 normalized-bone convention.
  //
  // Solved BEFORE the hands, because the wrist borrows its roll from the arm
  // chain (see applyHandRig).
  let poseRig: ReturnType<typeof Kalidokit.Pose.solve> | undefined;
  if (frame.poseWorldLandmarks && frame.poseWorldLandmarks.length > 20 && frame.poseLandmarks) {
    // Per-part gating: a hidden hip line must not freeze the arms (see
    // resolvePoseGates — that exact all-or-nothing bug shipped once).
    const gates = resolvePoseGates(frame.poseLandmarks, mode);

    if (gates.torso || gates.arms) {
      // Kalidokit reads visibility off the WORLD landmarks to decide whether an
      // arm is offscreen, and MediaPipe doesn't reliably fill it in there.
      const worldLandmarks = withLandmarkVisibility(
        frame.poseWorldLandmarks,
        frame.poseLandmarks
      )!;
      poseRig = Kalidokit.Pose.solve(worldLandmarks, frame.poseLandmarks, {
        runtime: "mediapipe",
        enableLegs: gates.legs,
      });

      if (poseRig) {
        if (gates.torso) {
          rigRotation(vrm, "hips", poseRig.Hips?.rotation as Rot, 0.7, LERP_BODY, true);
          rigRotation(vrm, "spine", poseRig.Spine as Rot, 0.45, LERP_BODY, true);
          rigRotation(vrm, "chest", poseRig.Spine as Rot, 0.25, LERP_BODY, true);
        }

        if (gates.arms) {
          // Arms are aimed at the measured joint positions rather than taken from
          // Kalidokit, whose clamps make a hand-to-face pose unreachable no matter
          // what the landmarks say (see armSolver). Kalidokit's arm output is the
          // fallback for when a joint isn't visible enough to aim from.
          for (const side of ["left", "right"] as const) {
            const aim = solveArmAim(frame.poseWorldLandmarks, frame.poseLandmarks, side);
            if (aim) {
              applyArmAim(vrm, side, aim);
            } else {
              const upper = side === "right" ? poseRig.RightUpperArm : poseRig.LeftUpperArm;
              const lower = side === "right" ? poseRig.RightLowerArm : poseRig.LeftLowerArm;
              rigRotation(vrm, `${side}UpperArm`, upper as Rot, 1, LERP_BODY, true);
              rigRotation(vrm, `${side}LowerArm`, lower as Rot, 1, LERP_BODY, true);
            }
          }
        }

        if (gates.legs) {
          rigRotation(vrm, "rightUpperLeg", poseRig.RightUpperLeg as Rot, 1, LERP_LEG, true);
          rigRotation(vrm, "rightLowerLeg", poseRig.RightLowerLeg as Rot, 1, LERP_LEG, true);
          rigRotation(vrm, "leftUpperLeg", poseRig.LeftUpperLeg as Rot, 1, LERP_LEG, true);
          rigRotation(vrm, "leftLowerLeg", poseRig.LeftLowerLeg as Rot, 1, LERP_LEG, true);
        }
      }
    }
  }

  // 3. Hands — wrist + 15 finger joints, crossed to the mirrored avatar side so
  // each hand lands on the arm driven by that same real limb. Runs after the pose
  // so the wrist's world->local conversion sees the final forearm rotation.
  applyHand(vrm, frame.leftHandLandmarks, frame.leftHandWorldLandmarks, "Left");
  applyHand(vrm, frame.rightHandLandmarks, frame.rightHandWorldLandmarks, "Right");
}

/**
 * Solves one hand from MediaPipe landmarks and writes it to the avatar.
 *
 * The two landmark sets are NOT interchangeable, and which one each part reads
 * is the whole reason fingers curl or don't:
 *
 * - FINGER ANGLES come from the WORLD landmarks. Joint angle is a 3D quantity,
 *   and the normalized landmarks are a bad space to measure it in: x is divided
 *   by the frame width but y by its height (so a 4:3 frame stretches y by a
 *   third), and their z is a weak relative depth. A fist pointed at the camera is
 *   the pose that breaks worst — the chain wrist->knuckle->joint->tip is almost
 *   entirely along the view axis, so once depth flattens, the projected chain is
 *   very nearly a straight line and every joint measures ~180 degrees, i.e. a
 *   fully OPEN hand. That was the on-device symptom: a tight fist barely curled.
 *   The world landmarks are metric and isotropic, which is what the angle
 *   formula assumes. Only angle MAGNITUDES are read here (Kalidokit's finger
 *   branch and solveThumbRig both use unsigned joint angles, with direction
 *   coming from the fixed per-side convention), so changing spaces cannot flip
 *   a curl direction — it only changes how much.
 *
 * - THE WRIST stays on the normalized landmarks: solveWristWorldQuaternion maps
 *   camera axes to model axes with per-axis signs pinned to how the raw frame is
 *   oriented, and that mapping was settled on a real device. World landmarks
 *   don't share the frame's axes, so reusing it there would silently rotate the
 *   hand.
 */
function applyHand(
  vrm: MotionAvatar,
  landmarks: NormalizedLandmark[] | undefined,
  worldLandmarks: { x: number; y: number; z: number }[] | undefined,
  solveSide: HandSide
) {
  if (!landmarks || landmarks.length < 21) return;
  const vrmSide = vrmSideForHand(solveSide);
  // Fall back to the normalized set when the metric one is missing, so a hand
  // still animates (just flatter) rather than freezing.
  const forAngles = worldLandmarks && worldLandmarks.length >= 21 ? worldLandmarks : landmarks;
  // Fingers: our own solver for all five digits (Kalidokit's joint measure runs
  // backwards past a right angle, and its thumb is hardcoded for VRM0 naming —
  // see solveFingerRig). Solved with the ANATOMICAL side, which fixes the curl
  // sign, then written to the mirrored avatar side.
  const handRig = solveFingerRig(forAngles, solveSide);
  // Wrist: our own solver, straight off the palm geometry.
  const wristWorld = solveWristWorldQuaternion(landmarks, vrmSide);
  applyHandRig(vrm, handRig, solveSide, vrmSide, wristWorld);
}

function cutoff(val: number, threshold: number): number {
  return val < threshold ? 0 : val;
}

function clampThreshold(val: number, low: number, high: number): number {
  if (val <= low) return 0;
  if (val >= high) return 1;
  return (val - low) / (high - low);
}
