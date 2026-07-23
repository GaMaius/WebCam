"use client";

import { useCallback, useRef, useState } from "react";
import { loadFaceLandmarker } from "@/lib/faceLandmarker";
import {
  computeRoiRegions,
  computeFaceCropBox,
  sampleRegionMean,
  sampleRegionAsRgbFrame,
} from "@/lib/roi";
import { posSignalFromRgbSeries, type RgbSample } from "@/lib/pos";
import { bandpassFilter, estimateBpmAndHrv } from "@/lib/signalProcessing";
import { loadDeepPhysSession, runDeepPhysInference, DEEPPHYS_IMG_SIZE, type RgbFrame } from "@/lib/deepPhys";
import { SESSION_KEYS, type HeartPulseResult } from "@/lib/types";

const SCAN_DURATION_MS = 15_000;
const MIN_USABLE_SAMPLES = 60; // guards against a near-instant, unusable clip
const WAVEFORM_POINTS = 150;
const DEEPPHYS_LOAD_TIMEOUT_MS = 4_000; // don't make the user wait indefinitely for the model

export type HeartPulseScanPhase = "idle" | "aligning" | "scanning" | "analyzing" | "done" | "error";
export type HeartPulseEngine = "deepphys" | "pos";

export interface HeartPulseScanState {
  phase: HeartPulseScanPhase;
  /** 0-1 progress through the 15s scan window. */
  progress: number;
  waveform: number[];
  result: HeartPulseResult | null;
  errorMessage: string;
  /** Which signal source actually produced the result — surfaced so the UI
   * can be transparent about a fallback happening. */
  engine: HeartPulseEngine | null;
}

export function useHeartPulseScan() {
  const [state, setState] = useState<HeartPulseScanState>({
    phase: "idle",
    progress: 0,
    waveform: [],
    result: null,
    errorMessage: "",
    engine: null,
  });

  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const samplesRef = useRef<RgbSample[]>([]);
  const faceCropsRef = useRef<RgbFrame[]>([]);
  const motionRef = useRef<{ totalDisplacement: number; sampleCount: number }>({
    totalDisplacement: 0,
    sampleCount: 0,
  });
  const lastCenterRef = useRef<{ x: number; y: number } | null>(null);
  const scanStartRef = useRef<number>(0);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stop();
    setState({ phase: "idle", progress: 0, waveform: [], result: null, errorMessage: "", engine: null });
  }, [stop]);

  const finish = useCallback(() => {
    stop();
    setState((s) => ({ ...s, phase: "analyzing" }));

    void (async () => {
      const samples = samplesRef.current;

      if (samples.length < MIN_USABLE_SAMPLES) {
        setState((s) => ({
          ...s,
          phase: "error",
          errorMessage: "측정 신호가 충분하지 않습니다. 얼굴이 가이드 안에 계속 보이도록 하고 다시 시도해주세요.",
        }));
        return;
      }

      try {
        const totalSeconds = samples[samples.length - 1].t / 1000;
        const fps = totalSeconds > 0 ? samples.length / totalSeconds : 30;

        let rawSignal: number[] | null = null;
        let effectiveFps = fps;
        let engine: HeartPulseEngine = "pos";

        // Prefer the pretrained DeepPhys model; fall back to the classical
        // POS algorithm if the model can't be loaded in time or inference
        // fails for any reason. Both feed the same downstream bandpass/BPM
        // pipeline, so the fallback is transparent to the rest of finish().
        //
        // DeepPhys runs one WASM inference call per frame (~15ms each in
        // testing) — at the full capture rate (~30fps) that's several
        // seconds of sequential inference. The target heart-rate band
        // (0.7-4Hz) only needs >8Hz by Nyquist, so we subsample frames for
        // this path specifically rather than making the user wait longer
        // than necessary; the effective (post-subsample) fps is what gets
        // passed to the bandpass/BPM step below.
        try {
          const session = await withTimeout(loadDeepPhysSession(), DEEPPHYS_LOAD_TIMEOUT_MS);
          const stride = 2;
          const subsampled = faceCropsRef.current.filter((_, i) => i % stride === 0);
          if (session && subsampled.length >= MIN_USABLE_SAMPLES) {
            rawSignal = await runDeepPhysInference(session, subsampled);
            effectiveFps = fps / stride;
            engine = "deepphys";
          }
        } catch (err) {
          console.warn("DeepPhys inference unavailable, falling back to POS:", err);
        }

        if (!rawSignal) {
          rawSignal = posSignalFromRgbSeries(samples, fps);
          effectiveFps = fps;
          engine = "pos";
        }

        const filtered = bandpassFilter(rawSignal, effectiveFps);
        const { bpm, sdnn, rmssd, beatsDetected } = estimateBpmAndHrv(filtered, effectiveFps);

        const avgMotion =
          motionRef.current.sampleCount > 0
            ? motionRef.current.totalDisplacement / motionRef.current.sampleCount
            : 0;
        // Heuristic: more frame-to-frame ROI displacement (head motion) and
        // fewer confidently-detected beats both erode trust in the reading.
        // No artificial floor — a genuinely bad capture (heavy motion, almost
        // no beats found) should be able to read as low confidence rather
        // than being reported as at least 20% trustworthy.
        const motionPenalty = Math.min(55, avgMotion * 6);
        const beatsPenalty = beatsDetected < 8 ? (8 - beatsDetected) * 5 : 0;
        const confidence = Math.max(0, Math.round(100 - motionPenalty - beatsPenalty));

        const clampedBpm = Math.min(220, Math.max(35, Math.round(bpm)));
        // Lower HRV (RMSSD) is associated with lower parasympathetic/vagal
        // activity, i.e. higher perceived stress — mapped onto a 0-100 scale.
        // The 120ms denominator (rather than clinical HRV norms) is
        // calibrated for this pipeline's actual noise floor: webcam rPPG
        // peak timing is far noisier than a real PPG sensor, so a tighter
        // scale was saturating almost every real reading to 0.
        const stressIndex =
          rmssd !== null ? Math.max(0, Math.min(100, Math.round(100 - Math.min(100, (rmssd / 120) * 100)))) : null;

        const result: HeartPulseResult = {
          bpm: clampedBpm,
          stressIndex,
          sdnn: sdnn !== null ? Math.round(sdnn) : null,
          rmssd: rmssd !== null ? Math.round(rmssd) : null,
          confidence,
          measuredAt: new Date().toISOString(),
        };

        try {
          sessionStorage.setItem(SESSION_KEYS.heartPulse, JSON.stringify(result));
        } catch {
          /* sessionStorage may be unavailable (private mode etc.) — non-fatal */
        }

        setState((s) => ({ ...s, phase: "done", progress: 1, result, engine }));
      } catch (err) {
        console.error("rPPG analysis failed:", err);
        setState((s) => ({
          ...s,
          phase: "error",
          errorMessage: "측정 분석 중 오류가 발생했습니다. 다시 시도해주세요.",
        }));
      }
    })();
  }, [stop]);

  const start = useCallback(
    async (video: HTMLVideoElement) => {
      stop();
      samplesRef.current = [];
      faceCropsRef.current = [];
      motionRef.current = { totalDisplacement: 0, sampleCount: 0 };
      lastCenterRef.current = null;
      setState({ phase: "aligning", progress: 0, waveform: [], result: null, errorMessage: "", engine: null });

      // Kick off the (larger, network-fetched) DeepPhys model load in
      // parallel with face-landmark loading, so it has the whole scan
      // window to finish rather than only starting once scanning ends.
      void loadDeepPhysSession().catch(() => {
        /* handled at finish()-time via the timeout + fallback */
      });

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
      if (!cropCanvasRef.current) cropCanvasRef.current = document.createElement("canvas");
      const canvas = canvasRef.current;
      const cropCanvas = cropCanvasRef.current;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setState((s) => ({ ...s, phase: "error", errorMessage: "이 브라우저에서는 분석을 진행할 수 없습니다." }));
        return;
      }

      let scanStarted = false;

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
          // No face yet (or momentarily lost) — keep waiting rather than
          // recording a bogus sample.
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        const regions = computeRoiRegions(landmarks, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const forehead = sampleRegionMean(ctx, regions.forehead, canvas.width, canvas.height);
        const leftCheek = sampleRegionMean(ctx, regions.leftCheek, canvas.width, canvas.height);
        const rightCheek = sampleRegionMean(ctx, regions.rightCheek, canvas.width, canvas.height);

        const r = (forehead.r + leftCheek.r + rightCheek.r) / 3;
        const g = (forehead.g + leftCheek.g + rightCheek.g) / 3;
        const b = (forehead.b + leftCheek.b + rightCheek.b) / 3;

        const faceCropBox = computeFaceCropBox(landmarks, canvas.width, canvas.height);
        const faceCrop = sampleRegionAsRgbFrame(video, faceCropBox, cropCanvas, DEEPPHYS_IMG_SIZE);
        faceCropsRef.current.push(faceCrop);

        if (lastCenterRef.current) {
          const dx = regions.center.x - lastCenterRef.current.x;
          const dy = regions.center.y - lastCenterRef.current.y;
          motionRef.current.totalDisplacement += Math.hypot(dx, dy);
          motionRef.current.sampleCount += 1;
        }
        lastCenterRef.current = regions.center;

        if (!scanStarted) {
          scanStarted = true;
          scanStartRef.current = now;
          setState((s) => ({ ...s, phase: "scanning" }));
        }

        const elapsed = now - scanStartRef.current;
        samplesRef.current.push({ t: elapsed, r, g, b });

        setState((s) => {
          const nextWaveform = [...s.waveform, g];
          return {
            ...s,
            progress: Math.min(1, elapsed / SCAN_DURATION_MS),
            waveform:
              nextWaveform.length > WAVEFORM_POINTS
                ? nextWaveform.slice(nextWaveform.length - WAVEFORM_POINTS)
                : nextWaveform,
          };
        });

        if (elapsed >= SCAN_DURATION_MS) {
          finish();
          return;
        }
        rafRef.current = requestAnimationFrame(loop);
      };

      rafRef.current = requestAnimationFrame(loop);
    },
    [finish, stop]
  );

  return { ...state, start, stop, reset };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
