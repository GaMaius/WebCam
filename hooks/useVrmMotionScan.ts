"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { loadFaceLandmarker, FaceLandmarker } from "@/lib/faceLandmarker";
import { loadPoseLandmarker, PoseLandmarker } from "@/lib/poseLandmarker";
import { loadHandLandmarker, HandLandmarker } from "@/lib/handLandmarker";
import {
  applyTrackingToVRM,
  LandmarkFrameData,
  _KalidokitForDebug,
  type TrackingMode,
} from "@/lib/vrm/kalidokitBridge";
import type { MotionAvatar } from "@/lib/vrm/motionAvatar";
import {
  EMPTY_HELD,
  HAND_HOLD_MS,
  POSE_HOLD_MS,
  holdLandmarks,
  planFrame,
  type HeldValue,
} from "@/lib/vrm/frameSchedule";

// Which stages run on which frame, and how stale a reading may get, both live in
// lib/vrm/frameSchedule.ts — including why the hands get every frame and the
// face/pose alternate rather than the other way round.

export function useVrmMotionScan(
  vrm: MotionAvatar | null,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  mode: TrackingMode = "upper"
) {
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [faceLandmarker, setFaceLandmarker] = useState<FaceLandmarker | null>(null);
  const [poseLandmarker, setPoseLandmarker] = useState<PoseLandmarker | null>(null);
  const [handLandmarker, setHandLandmarker] = useState<HandLandmarker | null>(null);

  const [fps, setFps] = useState(0);
  const [isFaceTracked, setIsFaceTracked] = useState(false);
  const [isPoseTracked, setIsPoseTracked] = useState(false);
  const [handCount, setHandCount] = useState(0);

  const lastVideoTimeRef = useRef(-1);
  const animFrameIdRef = useRef<number | null>(null);
  const frameCountRef = useRef(0);
  const lastFpsCalcTimeRef = useRef(performance.now());
  const fpsRef = useRef(0);
  const tickRef = useRef(0);
  // Each hand is held independently: one hand leaving the frame must not stall
  // the other, and a single dropped detection must not snap it to rest.
  const leftHandRef = useRef<HeldValue<NonNullable<LandmarkFrameData["leftHandLandmarks"]>>>(EMPTY_HELD);
  const rightHandRef = useRef<HeldValue<NonNullable<LandmarkFrameData["rightHandLandmarks"]>>>(EMPTY_HELD);
  // The face also runs on alternate frames now, so its last reading is reused in
  // between. No timed hold: a lost face should drop the expressions promptly.
  const lastFaceRef = useRef<{
    landmarks: NonNullable<LandmarkFrameData["faceLandmarks"]>;
    blendshapes?: LandmarkFrameData["faceBlendshapes"];
  } | null>(null);
  // The pose runs on alternate frames, so it's always held for at least a frame.
  const poseRef = useRef<
    HeldValue<{
      landmarks: NonNullable<LandmarkFrameData["poseLandmarks"]>;
      world?: LandmarkFrameData["poseWorldLandmarks"];
    }>
  >(EMPTY_HELD);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // 1. Initialize MediaPipe Models
  useEffect(() => {
    let isMounted = true;
    async function initModels() {
      try {
        const [faceLm, poseLm, handLm] = await Promise.all([
          loadFaceLandmarker(),
          loadPoseLandmarker(),
          loadHandLandmarker(),
        ]);
        if (isMounted) {
          setFaceLandmarker(faceLm);
          setPoseLandmarker(poseLm);
          setHandLandmarker(handLm);
          setIsLoadingModels(false);
        }
      } catch (e) {
        console.error("Failed to load MediaPipe models for VRM motion:", e);
        if (isMounted) setIsLoadingModels(false);
      }
    }
    initModels();
    return () => {
      isMounted = false;
    };
  }, []);

  // Dev-only: expose the VRM + bridge for deterministic mapping tests (?debug).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("debug")) return;
    (window as unknown as { __vrmDebug?: unknown }).__vrmDebug = { vrm, applyTrackingToVRM, Kalidokit: _KalidokitForDebug };
  }, [vrm]);

  // 2. Continuous Tracking Loop
  const processFrame = useCallback(() => {
    const video = videoRef.current;
    if (video && video.readyState >= 2 && !video.paused) {
      const now = performance.now();

      if (video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;
        tickRef.current++;

        const frameData: LandmarkFrameData = {};
        const plan = planFrame(tickRef.current, fpsRef.current);

        // Face tracking — head/neck plus the ARKit blendshapes. Halved rate: a
        // head turns far slower than a finger, and LERP_FACE smooths it anyway.
        if (faceLandmarker && plan.face) {
          try {
            const faceResult = faceLandmarker.detectForVideo(video, now);
            if (faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0) {
              lastFaceRef.current = {
                landmarks: faceResult.faceLandmarks[0],
                blendshapes: faceResult.faceBlendshapes?.[0]?.categories,
              };
              setIsFaceTracked(true);
            } else {
              lastFaceRef.current = null;
              setIsFaceTracked(false);
            }
          } catch (err) {
            // ignore frame error
          }
        }
        frameData.faceLandmarks = lastFaceRef.current?.landmarks;
        frameData.faceBlendshapes = lastFaceRef.current?.blendshapes;

        // Pose tracking — still needed in "upper" mode: arms/torso come from it,
        // only the legs are left undriven.
        if (poseLandmarker && plan.pose) {
          try {
            const poseResult = poseLandmarker.detectForVideo(video, now);
            const landmarks = poseResult.landmarks?.[0];
            poseRef.current = holdLandmarks(
              poseRef.current,
              landmarks ? { landmarks, world: poseResult.worldLandmarks?.[0] } : undefined,
              now,
              POSE_HOLD_MS
            );
            setIsPoseTracked(Boolean(poseRef.current.value));
          } catch (err) {
            // ignore frame error
          }
        }
        frameData.poseLandmarks = poseRef.current.value?.landmarks;
        frameData.poseWorldLandmarks = poseRef.current.value?.world;

        // Hand tracking, every frame. This is the stage that collapses when it's
        // starved, so it never gives up its slot (see frameSchedule.ts).
        if (handLandmarker && plan.hands) {
          try {
            const handResult = handLandmarker.detectForVideo(video, now);
            let left: LandmarkFrameData["leftHandLandmarks"];
            let right: LandmarkFrameData["rightHandLandmarks"];
            const hands = handResult.landmarks ?? [];
            hands.forEach((lm, i) => {
              // MediaPipe's handedness label is used verbatim as the VRM side.
              const label = handResult.handedness?.[i]?.[0]?.categoryName;
              if (label === "Left") left = lm;
              else if (label === "Right") right = lm;
            });
            leftHandRef.current = holdLandmarks(leftHandRef.current, left, now, HAND_HOLD_MS);
            rightHandRef.current = holdLandmarks(rightHandRef.current, right, now, HAND_HOLD_MS);
            setHandCount(
              (leftHandRef.current.value ? 1 : 0) + (rightHandRef.current.value ? 1 : 0)
            );
          } catch (err) {
            // ignore frame error
          }
        }
        frameData.leftHandLandmarks = leftHandRef.current.value;
        frameData.rightHandLandmarks = rightHandRef.current.value;

        // Apply tracking solved result to VRM avatar
        if (vrm) {
          applyTrackingToVRM(vrm, frameData, modeRef.current);
        }

        // FPS calculation. Kept in a ref as well, because the scheduler reads it
        // on the next frame and state updates land a render too late.
        frameCountRef.current++;
        if (now - lastFpsCalcTimeRef.current >= 1000) {
          const measured = (frameCountRef.current * 1000) / (now - lastFpsCalcTimeRef.current);
          fpsRef.current = measured;
          setFps(measured);
          frameCountRef.current = 0;
          lastFpsCalcTimeRef.current = now;
        }
      }
    }

    animFrameIdRef.current = requestAnimationFrame(processFrame);
  }, [faceLandmarker, poseLandmarker, handLandmarker, vrm, videoRef]);

  useEffect(() => {
    if (!isLoadingModels) {
      animFrameIdRef.current = requestAnimationFrame(processFrame);
    }
    return () => {
      if (animFrameIdRef.current !== null) {
        cancelAnimationFrame(animFrameIdRef.current);
      }
    };
  }, [isLoadingModels, processFrame]);

  return {
    isLoadingModels,
    fps,
    isFaceTracked,
    isPoseTracked,
    handCount,
  };
}
