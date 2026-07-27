"use client";

import { useCallback, useRef, useState } from "react";
import { loadFaceLandmarker } from "@/lib/faceLandmarker";
import { computeRoiRegions, sampleRegionMean, sampleRegionSkinMean, type RgbMean } from "@/lib/roi";
import { computeFaceGeometry, classifyFaceShape, type FaceLandmarkArray } from "@/lib/faceShape";
import { rgbToLab, rgbToHex, itaDegrees } from "@/lib/colorSpace";
import {
  grayWorldCorrection,
  classifyUndertone,
  classifySeason,
  classifyIta,
  rgbSampleStdDev,
} from "@/lib/personalColor";
import { SESSION_KEYS, type PersonalFrameResult } from "@/lib/types";
import type { CameraHandle } from "@/components/CameraView";

const FRONT_CAPTURE_MS = 1200; // short stable-capture window once a face is found
// The rear "ambient light" reading only needs to average out the scene, but
// 1s left almost no margin for the camera's autofocus/exposure to settle
// after the front->back switch, so a shaky or still-adjusting first few
// frames could dominate the average. A short warmup is discarded before the
// real accumulation window starts, and the window itself is longer so a
// brief wobble doesn't skew the whole reading.
const BACK_WARMUP_MS = 400;
const BACK_CAPTURE_MS = 2000;
const AMBIENT_SAMPLE_SIZE = 32; // downsample the back-camera frame for a cheap average

export type PersonalFrameScanPhase =
  | "idle"
  | "front-aligning"
  | "front-capturing"
  | "awaiting-switch"
  | "back-capturing"
  | "done"
  | "error";

export interface PersonalFrameScanState {
  phase: PersonalFrameScanPhase;
  progress: number; // 0-1 within whichever capture window is active
  result: PersonalFrameResult | null;
  errorMessage: string;
}

export function usePersonalFrameScan() {
  const [state, setState] = useState<PersonalFrameScanState>({
    phase: "idle",
    progress: 0,
    result: null,
    errorMessage: "",
  });

  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ambientCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const frontSkinRef = useRef<RgbMean | null>(null);
  const frontGeometryRef = useRef<FaceLandmarkArray | null>(null);
  const frontStdDevRef = useRef<number>(0);
  const frontSkinRatioRef = useRef<number>(0);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopLoop();
    frontSkinRef.current = null;
    frontGeometryRef.current = null;
    frontStdDevRef.current = 0;
    frontSkinRatioRef.current = 0;
    setState({ phase: "idle", progress: 0, result: null, errorMessage: "" });
  }, [stopLoop]);

  /** `ambientStdDev` is null when the rear-camera reading was skipped
   * entirely (no second camera) rather than actually measured — that case
   * gets a flat confidence penalty instead of pretending the (fabricated,
   * neutral-gray) ambient sample was a real measurement. */
  const finalize = useCallback((ambient: RgbMean, ambientStdDev: number | null) => {
    const skin = frontSkinRef.current;
    const landmarks = frontGeometryRef.current;
    if (!skin || !landmarks) {
      setState((s) => ({
        ...s,
        phase: "error",
        errorMessage: "전면 촬영 데이터가 없습니다. 처음부터 다시 시도해주세요.",
      }));
      return;
    }

    try {
      const corrected = grayWorldCorrection(skin, ambient);
      const lab = rgbToLab(corrected.r, corrected.g, corrected.b);
      const ita = itaDegrees(lab);
      const undertone = classifyUndertone(lab);
      const season = classifySeason(lab, undertone);
      const faceShape = classifyFaceShape(landmarks);
      const geometry = computeFaceGeometry(landmarks);

      // Confidence is a multiplicative composite of real capture-quality
      // sub-scores (each 0-1), following color-measurement QA practice rather
      // than a punitive linear penalty:
      //   - skinRatio: how much of the sampled ROIs actually classified as
      //     skin (a low ratio = the mask caught hair/shadow/background).
      //   - stability: temporal steadiness of the skin-color mean across
      //     frames, on a soft tolerance curve (normal skin has some spread,
      //     so full credit below ~8 and graceful rolloff to ~30).
      //   - exposure: the skin sample must not be clipped (too dark/bright),
      //     which would destroy the undertone signal.
      //   - white balance: a skipped ambient step is a missing correction
      //     opportunity, not a defect — a small cap (×0.9), not a big penalty.
      const ambientCorrected = ambientStdDev !== null;
      const skin01 = softRamp(frontSkinRatioRef.current, 0.3, 0.7); // 0.3 poor → 0.7 full
      const stability01 = softQuality(frontStdDevRef.current, 8, 30);
      const exposure01 = exposureQuality(skin);
      const wb01 = ambientCorrected ? 1 : 0.9;
      const confidence = Math.max(0, Math.min(100, Math.round(100 * skin01 * stability01 * exposure01 * wb01)));

      const result: PersonalFrameResult = {
        lab: { L: Math.round(lab.L * 10) / 10, a: Math.round(lab.a * 10) / 10, b: Math.round(lab.b * 10) / 10 },
        skinHex: rgbToHex(corrected.r, corrected.g, corrected.b),
        undertone,
        season,
        ita: Math.round(ita * 10) / 10,
        itaCategory: classifyIta(ita),
        faceShape,
        metrics: {
          thirds: [
            Math.round(geometry.thirds[0] * 100) / 100,
            Math.round(geometry.thirds[1] * 100) / 100,
            Math.round(geometry.thirds[2] * 100) / 100,
          ],
          lengthToWidth: Math.round(geometry.lengthToWidth * 100) / 100,
          jawAngle: Math.round(geometry.jawAngle * 10) / 10,
        },
        confidence,
        ambientCorrected,
        measuredAt: new Date().toISOString(),
      };

      try {
        sessionStorage.setItem(SESSION_KEYS.personalFrame, JSON.stringify(result));
      } catch {
        /* sessionStorage may be unavailable — non-fatal */
      }

      setState({ phase: "done", progress: 1, result, errorMessage: "" });
    } catch (err) {
      console.error("PersonalFrame analysis failed:", err);
      setState((s) => ({ ...s, phase: "error", errorMessage: "분석 중 오류가 발생했습니다. 다시 시도해주세요." }));
    }
  }, []);

  const startBackCapture = useCallback(
    (video: HTMLVideoElement) => {
      stopLoop();
      setState({ phase: "back-capturing", progress: 0, result: null, errorMessage: "" });

      if (!ambientCanvasRef.current) ambientCanvasRef.current = document.createElement("canvas");
      const canvas = ambientCanvasRef.current;
      canvas.width = AMBIENT_SAMPLE_SIZE;
      canvas.height = AMBIENT_SAMPLE_SIZE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setState((s) => ({ ...s, phase: "error", errorMessage: "이 브라우저에서는 분석을 진행할 수 없습니다." }));
        return;
      }

      let startTime: number | null = null;
      const samples: RgbMean[] = [];

      const loop = (now: number) => {
        if (video.videoWidth === 0) {
          rafRef.current = requestAnimationFrame(loop);
          return;
        }
        if (startTime === null) startTime = now;
        const sinceStart = now - startTime;

        // Discard the warmup window entirely (don't sample) so a still-
        // focusing/adjusting camera right after the facing-mode switch
        // doesn't get baked into the average.
        if (sinceStart < BACK_WARMUP_MS) {
          setState((s) => ({ ...s, progress: 0 }));
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        ctx.drawImage(video, 0, 0, AMBIENT_SAMPLE_SIZE, AMBIENT_SAMPLE_SIZE);
        samples.push(
          sampleRegionMean(ctx, { x: 0, y: 0, w: AMBIENT_SAMPLE_SIZE, h: AMBIENT_SAMPLE_SIZE }, AMBIENT_SAMPLE_SIZE, AMBIENT_SAMPLE_SIZE)
        );

        const elapsed = sinceStart - BACK_WARMUP_MS;
        setState((s) => ({ ...s, progress: Math.min(1, elapsed / BACK_CAPTURE_MS) }));

        if (elapsed >= BACK_CAPTURE_MS) {
          const ambient = {
            r: samples.reduce((sum, s) => sum + s.r, 0) / samples.length,
            g: samples.reduce((sum, s) => sum + s.g, 0) / samples.length,
            b: samples.reduce((sum, s) => sum + s.b, 0) / samples.length,
          };
          finalize(ambient, rgbSampleStdDev(samples));
          return;
        }
        rafRef.current = requestAnimationFrame(loop);
      };

      rafRef.current = requestAnimationFrame(loop);
    },
    [stopLoop, finalize]
  );

  const startFrontCapture = useCallback(
    async (video: HTMLVideoElement) => {
      stopLoop();
      frontSkinRef.current = null;
      frontGeometryRef.current = null;
      setState({ phase: "front-aligning", progress: 0, result: null, errorMessage: "" });

      let landmarker;
      try {
        landmarker = await loadFaceLandmarker();
      } catch (err) {
        console.error("failed to load face landmarker:", err);
        setState((s) => ({
          ...s,
          phase: "error",
          errorMessage: "얼굴 인식 모델을 불러오지 못했습니다. 네트워크 연결을 확인해주세요.",
        }));
        return;
      }

      if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setState((s) => ({ ...s, phase: "error", errorMessage: "이 브라우저에서는 분석을 진행할 수 없습니다." }));
        return;
      }

      let captureStart: number | null = null;
      const skinSamples: RgbMean[] = [];
      const skinRatios: number[] = [];
      let lastLandmarks: FaceLandmarkArray | null = null;

      const loop = (now: number) => {
        if (video.videoWidth === 0 || video.videoHeight === 0) {
          rafRef.current = requestAnimationFrame(loop);
          return;
        }
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }

        const detection = landmarker.detectForVideo(video, now);
        const landmarks = detection.faceLandmarks?.[0];

        if (!landmarks || landmarks.length === 0) {
          captureStart = null;
          skinSamples.length = 0;
          setState((s) => (s.phase === "front-aligning" ? s : { ...s, phase: "front-aligning", progress: 0 }));
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        lastLandmarks = landmarks;
        const regions = computeRoiRegions(landmarks, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        // Per-pixel skin-masked sampling: excludes eyebrows/shadow/specular
        // within each ROI rather than flat-averaging the whole rectangle.
        const forehead = sampleRegionSkinMean(ctx, regions.forehead, canvas.width, canvas.height);
        const leftCheek = sampleRegionSkinMean(ctx, regions.leftCheek, canvas.width, canvas.height);
        const rightCheek = sampleRegionSkinMean(ctx, regions.rightCheek, canvas.width, canvas.height);
        skinSamples.push({
          r: (forehead.r + leftCheek.r + rightCheek.r) / 3,
          g: (forehead.g + leftCheek.g + rightCheek.g) / 3,
          b: (forehead.b + leftCheek.b + rightCheek.b) / 3,
        });
        skinRatios.push((forehead.skinRatio + leftCheek.skinRatio + rightCheek.skinRatio) / 3);

        if (captureStart === null) {
          captureStart = now;
          setState((s) => ({ ...s, phase: "front-capturing", progress: 0 }));
        }

        const elapsed = now - captureStart;
        setState((s) => ({ ...s, progress: Math.min(1, elapsed / FRONT_CAPTURE_MS) }));

        if (elapsed >= FRONT_CAPTURE_MS) {
          frontSkinRef.current = {
            r: skinSamples.reduce((sum, s) => sum + s.r, 0) / skinSamples.length,
            g: skinSamples.reduce((sum, s) => sum + s.g, 0) / skinSamples.length,
            b: skinSamples.reduce((sum, s) => sum + s.b, 0) / skinSamples.length,
          };
          frontSkinRatioRef.current = skinRatios.reduce((a, b) => a + b, 0) / skinRatios.length;
          frontStdDevRef.current = rgbSampleStdDev(skinSamples);
          // Store landmarks in PIXEL space. MediaPipe returns per-axis
          // normalized coords (x by width, y by height); feeding those to the
          // angle/length-ratio math distorts jawAngle & lengthToWidth by the
          // frame's aspect ratio (device-dependent, nonsensical values).
          // Scaling by the actual frame size makes the geometry aspect-correct.
          frontGeometryRef.current = lastLandmarks
            ? lastLandmarks.map((p) => ({ x: p.x * canvas.width, y: p.y * canvas.height }))
            : null;
          stopLoop();
          setState((s) => ({ ...s, phase: "awaiting-switch", progress: 1 }));
          return;
        }
        rafRef.current = requestAnimationFrame(loop);
      };

      rafRef.current = requestAnimationFrame(loop);
    },
    [stopLoop]
  );

  const handleCameraReady = useCallback(
    (handle: CameraHandle) => {
      if (handle.facingMode === "user") {
        void startFrontCapture(handle.video);
      } else {
        startBackCapture(handle.video);
      }
    },
    [startFrontCapture, startBackCapture]
  );

  /** Escape hatch for single-camera devices (most laptops): proceed
   * without the ambient-light calibration step, assuming neutral light
   * rather than leaving the user stuck waiting to switch to a camera
   * that doesn't exist. */
  const skipBackCapture = useCallback(() => {
    stopLoop();
    finalize({ r: 128, g: 128, b: 128 }, null);
  }, [stopLoop, finalize]);

  return { ...state, handleCameraReady, reset, stop: stopLoop, skipBackCapture };
}

/** Soft tolerance curve: full credit (1) at/below `good`, linear rolloff to
 * 0 at `bad`. Avoids the over-punitive linear ×N penalty on normal spread. */
function softQuality(value: number, good: number, bad: number): number {
  if (value <= good) return 1;
  if (value >= bad) return 0;
  return 1 - (value - good) / (bad - good);
}

/** Rising soft ramp: 0 at/below `low`, full credit (1) at/above `high`. */
function softRamp(value: number, low: number, high: number): number {
  if (value <= low) return 0;
  if (value >= high) return 1;
  return (value - low) / (high - low);
}

/** Penalizes a skin sample whose channels approach clipping — a blown or
 * crushed sample loses the chroma that undertone classification depends on. */
function exposureQuality(skin: RgbMean): number {
  const mx = Math.max(skin.r, skin.g, skin.b);
  const mn = Math.min(skin.r, skin.g, skin.b);
  const over = Math.max(0, Math.min(1, (mx - 235) / (255 - 235))); // >235 → clipping
  const under = Math.max(0, Math.min(1, (25 - mn) / 25)); // <25 → crushed
  return 1 - Math.max(over, under);
}
