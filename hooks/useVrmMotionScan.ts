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

// Tracking quality is mostly a frame-rate problem: MediaPipe's VIDEO mode tracks
// between frames, so starving it makes every stage worse. Running face + pose +
// hands on every frame is far more than a phone can do, so the two expensive
// stages alternate — each frame does the face plus ONE of pose/hands, and the
// other's last result is held. That roughly halves the per-frame cost.
//
// (Reference point: the gesture-synth app the user found tracks hands well while
// running the same model with the same options — its advantage is that hands are
// the only model it runs, at 640x480.)
const HAND_EVERY_N_FRAMES = 2;
const POSE_EVERY_N_FRAMES = 2;
/** Offset so pose and hands never land on the same frame. */
const POSE_PHASE = 1;

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
  const tickRef = useRef(0);
  // Hands persist across skipped frames so the avatar doesn't drop back to a
  // rest pose every other frame.
  const lastHandsRef = useRef<{
    left?: LandmarkFrameData["leftHandLandmarks"];
    right?: LandmarkFrameData["rightHandLandmarks"];
  }>({});
  // Same for the pose, which now also runs at half rate.
  const lastPoseRef = useRef<{
    landmarks?: LandmarkFrameData["poseLandmarks"];
    world?: LandmarkFrameData["poseWorldLandmarks"];
  }>({});
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

        // Face tracking
        if (faceLandmarker) {
          try {
            const faceResult = faceLandmarker.detectForVideo(video, now);
            if (faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0) {
              frameData.faceLandmarks = faceResult.faceLandmarks[0];
              frameData.faceBlendshapes = faceResult.faceBlendshapes?.[0]?.categories;
              setIsFaceTracked(true);
            } else {
              setIsFaceTracked(false);
            }
          } catch (err) {
            // ignore frame error
          }
        }

        // Pose tracking — still needed in "upper" mode: arms/torso come from it,
        // only the legs are left undriven. Runs on alternate frames from the hands.
        if (poseLandmarker && tickRef.current % POSE_EVERY_N_FRAMES === POSE_PHASE) {
          try {
            const poseResult = poseLandmarker.detectForVideo(video, now);
            if (poseResult.landmarks && poseResult.landmarks.length > 0) {
              lastPoseRef.current = {
                landmarks: poseResult.landmarks[0],
                world: poseResult.worldLandmarks?.[0],
              };
              setIsPoseTracked(true);
            } else {
              lastPoseRef.current = {};
              setIsPoseTracked(false);
            }
          } catch (err) {
            // ignore frame error
          }
        }
        frameData.poseLandmarks = lastPoseRef.current.landmarks;
        frameData.poseWorldLandmarks = lastPoseRef.current.world;

        // Hand tracking, at reduced cadence.
        if (handLandmarker && tickRef.current % HAND_EVERY_N_FRAMES === 0) {
          try {
            const handResult = handLandmarker.detectForVideo(video, now);
            const next: typeof lastHandsRef.current = {};
            const hands = handResult.landmarks ?? [];
            hands.forEach((lm, i) => {
              // MediaPipe's handedness label is used verbatim as the VRM side.
              const label = handResult.handedness?.[i]?.[0]?.categoryName;
              if (label === "Left") next.left = lm;
              else if (label === "Right") next.right = lm;
            });
            lastHandsRef.current = next;
            setHandCount(hands.length);
          } catch (err) {
            // ignore frame error
          }
        }
        frameData.leftHandLandmarks = lastHandsRef.current.left;
        frameData.rightHandLandmarks = lastHandsRef.current.right;

        // Apply tracking solved result to VRM avatar
        if (vrm) {
          applyTrackingToVRM(vrm, frameData, modeRef.current);
        }

        // FPS calculation
        frameCountRef.current++;
        if (now - lastFpsCalcTimeRef.current >= 1000) {
          setFps((frameCountRef.current * 1000) / (now - lastFpsCalcTimeRef.current));
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
