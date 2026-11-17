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
import {
  LandmarkSmoother,
  SMOOTH_FACE,
  SMOOTH_IMAGE,
  SMOOTH_WORLD,
} from "@/lib/vrm/oneEuro";
import { assignHands, type HandDetection, type LastWrists } from "@/lib/vrm/handAssign";
import {
  buildCalibration,
  parseCalibration,
  type CalibrationProfile,
  type CalibrationSample,
} from "@/lib/vrm/calibration";

// Which stages run on which frame, and how stale a reading may get, both live in
// lib/vrm/frameSchedule.ts — including why the hands get every frame and the
// face/pose alternate rather than the other way round.
//
// Per frame, in order: detect → One Euro smoothing (lib/vrm/oneEuro.ts) → for
// hands, side assignment by continuity (lib/vrm/handAssign.ts) → hold on
// dropout → solve + apply with the user's calibration (lib/vrm/calibration.ts).

/** One hand's two landmark sets, kept together so a held hand keeps both. */
interface HandReading {
  landmarks: NonNullable<LandmarkFrameData["leftHandLandmarks"]>;
  world?: LandmarkFrameData["leftHandWorldLandmarks"];
}

/** Where the calibration lives between visits. Per-viewer convenience only —
 * losing it just means calibrating again. */
const CALIBRATION_STORAGE_KEY = "visionlab.vrmmotion.calibration.v1";
/** Countdown before recording, so the user can sit back and look at the screen. */
export const CALIBRATION_COUNTDOWN_MS = 3000;
/** How long the neutral pose is recorded. */
export const CALIBRATION_RECORD_MS = 1500;
/** A hand's last wrist position counts as continuity evidence only briefly. */
const WRIST_MEMORY_MS = 500;

export type CalibrationPhase = "idle" | "countdown" | "recording" | "failed";

function loadStoredCalibration(): CalibrationProfile | null {
  try {
    const raw = window.localStorage.getItem(CALIBRATION_STORAGE_KEY);
    return raw ? parseCalibration(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function storeCalibration(profile: CalibrationProfile | null) {
  try {
    if (profile) window.localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(profile));
    else window.localStorage.removeItem(CALIBRATION_STORAGE_KEY);
  } catch {
    // Private mode / blocked storage: calibration still works for this visit.
  }
}

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
  // the other, and a single dropped detection must not snap it to rest. Both
  // landmark sets travel together — the bridge needs the normalized set for the
  // wrist and the metric one for the finger angles.
  const leftHandRef = useRef<HeldValue<HandReading>>(EMPTY_HELD);
  const rightHandRef = useRef<HeldValue<HandReading>>(EMPTY_HELD);
  // The face's last reading is reused on frames where it isn't detected. No
  // timed hold: a lost face should drop the expressions promptly.
  const lastFaceRef = useRef<{
    landmarks: NonNullable<LandmarkFrameData["faceLandmarks"]>;
    blendshapes?: LandmarkFrameData["faceBlendshapes"];
  } | null>(null);
  // The pose runs every third frame, so it's always held for a couple of frames.
  const poseRef = useRef<
    HeldValue<{
      landmarks: NonNullable<LandmarkFrameData["poseLandmarks"]>;
      world?: LandmarkFrameData["poseWorldLandmarks"];
    }>
  >(EMPTY_HELD);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // One Euro smoothing per landmark stream. Separate instances per stream and
  // per hand side: their units and dynamics differ, and a filter must never
  // blend one hand's history into the other's.
  const smoothersRef = useRef({
    face: new LandmarkSmoother(SMOOTH_FACE),
    poseImage: new LandmarkSmoother(SMOOTH_IMAGE),
    poseWorld: new LandmarkSmoother(SMOOTH_WORLD),
    leftImage: new LandmarkSmoother(SMOOTH_IMAGE),
    leftWorld: new LandmarkSmoother(SMOOTH_WORLD),
    rightImage: new LandmarkSmoother(SMOOTH_IMAGE),
    rightWorld: new LandmarkSmoother(SMOOTH_WORLD),
  });
  const lastWristsRef = useRef<{ wrists: LastWrists; at: { Left: number; Right: number } }>({
    wrists: {},
    at: { Left: 0, Right: 0 },
  });

  // ── Calibration ──────────────────────────────────────────────────────────
  // The profile is read in the rAF loop through a ref; state is for the UI.
  const [calibration, setCalibration] = useState<CalibrationProfile | null>(null);
  const calibrationRef = useRef<CalibrationProfile | null>(null);
  const [calibrationPhase, setCalibrationPhase] = useState<CalibrationPhase>("idle");
  const [calibrationCountdown, setCalibrationCountdown] = useState(0);
  const calibrationPhaseRef = useRef<CalibrationPhase>("idle");
  const calibrationSamplesRef = useRef<CalibrationSample[]>([]);
  const calibrationTimersRef = useRef<number[]>([]);

  useEffect(() => {
    const stored = loadStoredCalibration();
    calibrationRef.current = stored;
    setCalibration(stored);
  }, []);

  const setPhase = useCallback((phase: CalibrationPhase) => {
    calibrationPhaseRef.current = phase;
    setCalibrationPhase(phase);
  }, []);

  const clearCalibrationTimers = useCallback(() => {
    calibrationTimersRef.current.forEach((t) => window.clearTimeout(t));
    calibrationTimersRef.current = [];
  }, []);

  /** Countdown → record the neutral pose → build and store the profile. */
  const startCalibration = useCallback(() => {
    clearCalibrationTimers();
    calibrationSamplesRef.current = [];
    setPhase("countdown");
    const seconds = Math.ceil(CALIBRATION_COUNTDOWN_MS / 1000);
    setCalibrationCountdown(seconds);
    const timers = calibrationTimersRef.current;
    for (let i = 1; i < seconds; i++) {
      timers.push(window.setTimeout(() => setCalibrationCountdown(seconds - i), i * 1000));
    }
    timers.push(
      window.setTimeout(() => {
        calibrationSamplesRef.current = [];
        setCalibrationCountdown(0);
        setPhase("recording");
      }, CALIBRATION_COUNTDOWN_MS)
    );
    timers.push(
      window.setTimeout(() => {
        const profile = buildCalibration(calibrationSamplesRef.current);
        calibrationSamplesRef.current = [];
        if (profile) {
          calibrationRef.current = profile;
          setCalibration(profile);
          storeCalibration(profile);
          setPhase("idle");
        } else {
          // Not enough face frames — usually the face left the camera.
          setPhase("failed");
        }
      }, CALIBRATION_COUNTDOWN_MS + CALIBRATION_RECORD_MS)
    );
  }, [clearCalibrationTimers, setPhase]);

  const cancelCalibration = useCallback(() => {
    clearCalibrationTimers();
    calibrationSamplesRef.current = [];
    setCalibrationCountdown(0);
    setPhase("idle");
  }, [clearCalibrationTimers, setPhase]);

  const resetCalibration = useCallback(() => {
    cancelCalibration();
    calibrationRef.current = null;
    setCalibration(null);
    storeCalibration(null);
  }, [cancelCalibration]);

  useEffect(() => clearCalibrationTimers, [clearCalibrationTimers]);

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
    (window as unknown as { __vrmDebug?: unknown }).__vrmDebug = {
      vrm,
      applyTrackingToVRM,
      Kalidokit: _KalidokitForDebug,
      calibration: () => calibrationRef.current,
    };
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
        const sm = smoothersRef.current;
        let faceDetectedThisFrame = false;

        // Face tracking — head/neck plus the ARKit blendshapes.
        if (faceLandmarker && plan.face) {
          try {
            const faceResult = faceLandmarker.detectForVideo(video, now);
            if (faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0) {
              lastFaceRef.current = {
                landmarks: sm.face.smooth(faceResult.faceLandmarks[0], now)!,
                blendshapes: faceResult.faceBlendshapes?.[0]?.categories,
              };
              faceDetectedThisFrame = true;
              setIsFaceTracked(true);
            } else {
              lastFaceRef.current = null;
              setIsFaceTracked(false);
            }
          } catch {
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
              landmarks
                ? {
                    landmarks: sm.poseImage.smooth(landmarks, now)!,
                    world: sm.poseWorld.smooth(poseResult.worldLandmarks?.[0], now),
                  }
                : undefined,
              now,
              POSE_HOLD_MS
            );
            setIsPoseTracked(Boolean(poseRef.current.value));
          } catch {
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
            const hands = handResult.landmarks ?? [];
            const detections: HandDetection<HandReading>[] = hands.map((lm, i) => ({
              label: handResult.handedness?.[i]?.[0]?.categoryName,
              wrist: { x: lm[0].x, y: lm[0].y },
              // The metric landmarks share the normalized list's indexing; the
              // bridge needs both (normalized wrist, metric finger angles).
              reading: { landmarks: lm, world: handResult.worldLandmarks?.[i] },
            }));

            // Side by continuity first, MediaPipe's label second: the label
            // flips frame to frame, hands don't teleport.
            const memory = lastWristsRef.current;
            const recent: LastWrists = {};
            if (memory.wrists.Left && now - memory.at.Left < WRIST_MEMORY_MS) {
              recent.Left = memory.wrists.Left;
            }
            if (memory.wrists.Right && now - memory.at.Right < WRIST_MEMORY_MS) {
              recent.Right = memory.wrists.Right;
            }
            const assigned = assignHands(detections, recent);
            for (const side of ["Left", "Right"] as const) {
              const w = assigned.wrists[side];
              if (w) {
                memory.wrists[side] = w;
                memory.at[side] = now;
              }
            }

            const left: HandReading | undefined = assigned.Left && {
              landmarks: sm.leftImage.smooth(assigned.Left.landmarks, now)!,
              world: sm.leftWorld.smooth(assigned.Left.world, now),
            };
            const right: HandReading | undefined = assigned.Right && {
              landmarks: sm.rightImage.smooth(assigned.Right.landmarks, now)!,
              world: sm.rightWorld.smooth(assigned.Right.world, now),
            };
            leftHandRef.current = holdLandmarks(leftHandRef.current, left, now, HAND_HOLD_MS);
            rightHandRef.current = holdLandmarks(rightHandRef.current, right, now, HAND_HOLD_MS);
            setHandCount(
              (leftHandRef.current.value ? 1 : 0) + (rightHandRef.current.value ? 1 : 0)
            );
          } catch {
            // ignore frame error
          }
        }
        frameData.leftHandLandmarks = leftHandRef.current.value?.landmarks;
        frameData.leftHandWorldLandmarks = leftHandRef.current.value?.world;
        frameData.rightHandLandmarks = rightHandRef.current.value?.landmarks;
        frameData.rightHandWorldLandmarks = rightHandRef.current.value?.world;

        if (vrm) {
          const sample = applyTrackingToVRM(
            vrm,
            frameData,
            modeRef.current,
            calibrationRef.current
          );
          // Only frames with a FRESH face detection count: the held face is
          // reused between detections and would just duplicate samples.
          if (calibrationPhaseRef.current === "recording" && faceDetectedThisFrame) {
            calibrationSamplesRef.current.push(sample);
          }
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
    calibration,
    calibrationPhase,
    calibrationCountdown,
    startCalibration,
    cancelCalibration,
    resetCalibration,
  };
}
