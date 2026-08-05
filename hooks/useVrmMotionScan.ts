"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { loadFaceLandmarker, FaceLandmarker } from "@/lib/faceLandmarker";
import { loadPoseLandmarker, PoseLandmarker } from "@/lib/poseLandmarker";
import { applyTrackingToVRM, LandmarkFrameData } from "@/lib/vrm/kalidokitBridge";
import type { VRM } from "@pixiv/three-vrm";

export function useVrmMotionScan(vrm: VRM | null, videoRef: React.RefObject<HTMLVideoElement | null>) {
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [faceLandmarker, setFaceLandmarker] = useState<FaceLandmarker | null>(null);
  const [poseLandmarker, setPoseLandmarker] = useState<PoseLandmarker | null>(null);

  const [fps, setFps] = useState(0);
  const [isFaceTracked, setIsFaceTracked] = useState(false);
  const [isPoseTracked, setIsPoseTracked] = useState(false);

  const lastVideoTimeRef = useRef(-1);
  const animFrameIdRef = useRef<number | null>(null);
  const frameCountRef = useRef(0);
  const lastFpsCalcTimeRef = useRef(performance.now());

  // 1. Initialize MediaPipe Models
  useEffect(() => {
    let isMounted = true;
    async function initModels() {
      try {
        const [faceLm, poseLm] = await Promise.all([
          loadFaceLandmarker(),
          loadPoseLandmarker(),
        ]);
        if (isMounted) {
          setFaceLandmarker(faceLm);
          setPoseLandmarker(poseLm);
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
    (window as unknown as { __vrmDebug?: unknown }).__vrmDebug = { vrm, applyTrackingToVRM };
  }, [vrm]);

  // 2. Continuous Tracking Loop
  const processFrame = useCallback(() => {
    const video = videoRef.current;
    if (video && video.readyState >= 2 && !video.paused) {
      const now = performance.now();

      if (video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;

        const frameData: LandmarkFrameData = {};

        // Face tracking
        if (faceLandmarker) {
          try {
            const faceResult = faceLandmarker.detectForVideo(video, now);
            if (faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0) {
              frameData.faceLandmarks = faceResult.faceLandmarks[0];
              setIsFaceTracked(true);
            } else {
              setIsFaceTracked(false);
            }
          } catch (err) {
            // ignore frame error
          }
        }

        // Pose tracking
        if (poseLandmarker) {
          try {
            const poseResult = poseLandmarker.detectForVideo(video, now);
            if (poseResult.landmarks && poseResult.landmarks.length > 0) {
              frameData.poseLandmarks = poseResult.landmarks[0];
              frameData.poseWorldLandmarks = poseResult.worldLandmarks?.[0];
              setIsPoseTracked(true);
            } else {
              setIsPoseTracked(false);
            }
          } catch (err) {
            // ignore frame error
          }
        }

        // Apply tracking solved result to VRM avatar
        if (vrm) {
          applyTrackingToVRM(vrm, frameData);
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
  }, [faceLandmarker, poseLandmarker, vrm, videoRef]);

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
  };
}
