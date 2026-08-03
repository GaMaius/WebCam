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

function getNode(vrm: VRM, boneName: any) {
  if (!vrm.humanoid) return null;
  return (
    vrm.humanoid.getNormalizedBoneNode(boneName) ||
    vrm.humanoid.getRawBoneNode(boneName)
  );
}

// Deadzone & Low-Pass Filter constants to eliminate micro-jittering when still
const ROTATION_DEADZONE_RAD = 0.02; // ~1.1 degrees deadzone threshold
const SLERP_SPEED = 0.18; // Smooth exponential moving average speed
const FACE_ROT_SPEED = 0.25;

/**
 * Apply Kalidokit tracking solved results to a three-vrm instance with Deadzone & Mirroring.
 */
export function applyTrackingToVRM(vrm: VRM, frame: LandmarkFrameData) {
  if (!vrm) return;

  // 1. Face Tracking & Expressions
  if (frame.faceLandmarks && frame.faceLandmarks.length > 0) {
    const faceRig = Kalidokit.Face.solve(frame.faceLandmarks, {
      runtime: "mediapipe",
      smoothBlink: true,
    });

    if (faceRig) {
      // Head & Neck Rotation using Mirrored YXZ Euler Order (-x Pitch, -y Yaw, -z Roll)
      rotateHeadAndNeck(vrm, faceRig.head);

      // Expressions (Eye Blink & Mouth Shape)
      if (vrm.expressionManager) {
        // Mirrored eye blink:
        // User right eye (screen-left) -> VRM blinkRight (screen-left)
        // User left eye (screen-right) -> VRM blinkLeft (screen-right)
        const blinkRight = clampThreshold(1 - faceRig.eye.r, 0.15, 0.85);
        const blinkLeft = clampThreshold(1 - faceRig.eye.l, 0.15, 0.85);

        vrm.expressionManager.setValue("blinkRight", blinkRight);
        vrm.expressionManager.setValue("blinkLeft", blinkLeft);

        // Mouth blendshapes with 0.08 cutoff deadzone
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

  // 2. Pose Kinematics
  if (frame.poseWorldLandmarks && frame.poseWorldLandmarks.length > 20 && frame.poseLandmarks) {
    // Visibility check: if key landmarks are hidden/missing, skip update to prevent ghost motion
    const hipLandmark = frame.poseLandmarks[23] || frame.poseLandmarks[24];
    if (hipLandmark && (hipLandmark.visibility ?? 1) < 0.25) {
      return;
    }

    const poseRig = Kalidokit.Pose.solve(frame.poseWorldLandmarks, frame.poseLandmarks, {
      runtime: "mediapipe",
      enableLegs: true,
    });

    if (poseRig) {
      // Hips & Spine (Mirrored -x, -y, -z)
      rotateBoneWithDeadzone(vrm, "hips", mirrorRotation(extractRotation(poseRig.Hips)), SLERP_SPEED);
      rotateBoneWithDeadzone(vrm, "spine", mirrorRotation(extractRotation(poseRig.Spine)), SLERP_SPEED);
      rotateBoneWithDeadzone(vrm, "chest", mirrorRotation(extractRotation(poseRig.Spine)), SLERP_SPEED);

      // Arms (Swapped for mirrored webcam view)
      rotateBoneWithDeadzone(vrm, "leftUpperArm", mirrorRotation(extractRotation(poseRig.RightUpperArm)), SLERP_SPEED);
      rotateBoneWithDeadzone(vrm, "leftLowerArm", mirrorRotation(extractRotation(poseRig.RightLowerArm)), SLERP_SPEED);

      rotateBoneWithDeadzone(vrm, "rightUpperArm", mirrorRotation(extractRotation(poseRig.LeftUpperArm)), SLERP_SPEED);
      rotateBoneWithDeadzone(vrm, "rightLowerArm", mirrorRotation(extractRotation(poseRig.LeftLowerArm)), SLERP_SPEED);

      // Legs (Swapped for mirrored webcam view)
      rotateBoneWithDeadzone(vrm, "leftUpperLeg", mirrorRotation(extractRotation(poseRig.RightUpperLeg)), SLERP_SPEED);
      rotateBoneWithDeadzone(vrm, "leftLowerLeg", mirrorRotation(extractRotation(poseRig.RightLowerLeg)), SLERP_SPEED);

      rotateBoneWithDeadzone(vrm, "rightUpperLeg", mirrorRotation(extractRotation(poseRig.LeftUpperLeg)), SLERP_SPEED);
      rotateBoneWithDeadzone(vrm, "rightLowerLeg", mirrorRotation(extractRotation(poseRig.LeftUpperLeg)), SLERP_SPEED);
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

function mirrorRotation(rot: { x: number; y: number; z: number } | undefined) {
  if (!rot) return undefined;
  return {
    x: -rot.x,
    y: -rot.y,
    z: -rot.z,
  };
}

function rotateHeadAndNeck(vrm: VRM, headRot: { x: number; y: number; z: number }) {
  // Use YXZ Euler order with mirrored signs (-x Pitch, -y Yaw, -z Roll)
  const headNode = getNode(vrm, "head");
  if (headNode) {
    const targetQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-headRot.x, -headRot.y, -headRot.z, "YXZ")
    );
    if (headNode.quaternion.angleTo(targetQuat) > ROTATION_DEADZONE_RAD) {
      headNode.quaternion.slerp(targetQuat, FACE_ROT_SPEED);
    }
  }

  const neckNode = getNode(vrm, "neck");
  if (neckNode) {
    const targetQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-headRot.x * 0.3, -headRot.y * 0.3, -headRot.z * 0.3, "YXZ")
    );
    if (neckNode.quaternion.angleTo(targetQuat) > ROTATION_DEADZONE_RAD) {
      neckNode.quaternion.slerp(targetQuat, FACE_ROT_SPEED);
    }
  }
}

function extractRotation(item: any): { x: number; y: number; z: number } | undefined {
  if (!item) return undefined;
  if ("rotation" in item && item.rotation) {
    return item.rotation;
  }
  if (typeof item.x === "number" && typeof item.y === "number" && typeof item.z === "number") {
    return { x: item.x, y: item.y, z: item.z };
  }
  return undefined;
}

function rotateBoneWithDeadzone(
  vrm: VRM,
  boneName: any,
  rotation: { x: number; y: number; z: number } | undefined,
  speed: number = SLERP_SPEED
) {
  if (!rotation) return;
  const boneNode = getNode(vrm, boneName);
  if (!boneNode) return;

  // Use YXZ Euler order for stable bone kinematics
  const targetEuler = new THREE.Euler(rotation.x, rotation.y, rotation.z, "YXZ");
  const targetQuat = new THREE.Quaternion().setFromEuler(targetEuler);

  // Deadzone filter: Ignore tiny rotational fluctuations
  if (boneNode.quaternion.angleTo(targetQuat) > ROTATION_DEADZONE_RAD) {
    boneNode.quaternion.slerp(targetQuat, speed);
  }
}
