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

/**
 * Apply Kalidokit tracking solved results to a three-vrm instance.
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
      // Head Rotation
      const headNode = getNode(vrm, "head");
      if (headNode) {
        const euler = new THREE.Euler(
          faceRig.head.x,
          faceRig.head.y,
          faceRig.head.z,
          "XYZ"
        );
        headNode.quaternion.slerp(new THREE.Quaternion().setFromEuler(euler), 0.4);
      }

      // Neck Rotation
      const neckNode = getNode(vrm, "neck");
      if (neckNode) {
        const euler = new THREE.Euler(
          faceRig.head.x * 0.3,
          faceRig.head.y * 0.3,
          faceRig.head.z * 0.3,
          "XYZ"
        );
        neckNode.quaternion.slerp(new THREE.Quaternion().setFromEuler(euler), 0.4);
      }

      // Expressions (Eye Blink, Mouth A/I/U/E/O)
      if (vrm.expressionManager) {
        vrm.expressionManager.setValue("blinkLeft", 1 - faceRig.eye.l);
        vrm.expressionManager.setValue("blinkRight", 1 - faceRig.eye.r);

        // Mouth blendshapes
        if (faceRig.mouth) {
          vrm.expressionManager.setValue("aa", faceRig.mouth.shape.A);
          vrm.expressionManager.setValue("ih", faceRig.mouth.shape.I);
          vrm.expressionManager.setValue("ou", faceRig.mouth.shape.U);
          vrm.expressionManager.setValue("ee", faceRig.mouth.shape.E);
          vrm.expressionManager.setValue("oh", faceRig.mouth.shape.O);
        }
      }
    }
  }

  // 2. Pose Kinematics
  if (frame.poseWorldLandmarks && frame.poseWorldLandmarks.length > 0 && frame.poseLandmarks) {
    const poseRig = Kalidokit.Pose.solve(frame.poseWorldLandmarks, frame.poseLandmarks, {
      runtime: "mediapipe",
      enableLegs: true,
    });

    if (poseRig) {
      // Hips & Spine
      rotateBone(vrm, "hips", extractRotation(poseRig.Hips), 0.3);
      rotateBone(vrm, "spine", extractRotation(poseRig.Spine), 0.3);
      rotateBone(vrm, "chest", extractRotation(poseRig.Spine), 0.3);

      // Left Arm
      rotateBone(vrm, "leftUpperArm", extractRotation(poseRig.LeftUpperArm), 0.4);
      rotateBone(vrm, "leftLowerArm", extractRotation(poseRig.LeftLowerArm), 0.4);

      // Right Arm
      rotateBone(vrm, "rightUpperArm", extractRotation(poseRig.RightUpperArm), 0.4);
      rotateBone(vrm, "rightLowerArm", extractRotation(poseRig.RightLowerArm), 0.4);

      // Left Leg
      rotateBone(vrm, "leftUpperLeg", extractRotation(poseRig.LeftUpperLeg), 0.3);
      rotateBone(vrm, "leftLowerLeg", extractRotation(poseRig.LeftLowerLeg), 0.3);

      // Right Leg
      rotateBone(vrm, "rightUpperLeg", extractRotation(poseRig.RightUpperLeg), 0.3);
      rotateBone(vrm, "rightLowerLeg", extractRotation(poseRig.RightLowerLeg), 0.3);
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

function rotateBone(
  vrm: VRM,
  boneName: any,
  rotation: { x: number; y: number; z: number } | undefined,
  speed: number = 0.3
) {
  if (!rotation) return;
  const boneNode = getNode(vrm, boneName);
  if (!boneNode) return;

  const euler = new THREE.Euler(rotation.x, rotation.y, rotation.z, "XYZ");
  const targetQuaternion = new THREE.Quaternion().setFromEuler(euler);

  boneNode.quaternion.slerp(targetQuaternion, speed);
}
