"use client";

import { useCallback, useRef, useState } from "react";
import { loadFaceLandmarker } from "@/lib/faceLandmarker";
import {
  computeRoiRegions,
  computeFaceCropBox,
  sampleRegionMean,
  sampleRegionSkinMean,
  sampleRegionAsRgbFrame,
  isRegionUsableSkin,
} from "@/lib/roi";
import { posSignalFromRgbSeries, type RgbSample } from "@/lib/pos";
import { bandpassFilter, estimateBpmAndHrv, resampleUniform } from "@/lib/signalProcessing";
import {
  loadTsCanModel,
  runTsCanWindow,
  integratePulse,
  TSCAN_IMG_SIZE,
  TSCAN_WINDOW,
  type RgbFrame,
} from "@/lib/heartpulse/tsCan";
import { SESSION_KEYS, type HeartPulseResult } from "@/lib/types";

// Selectable scan length. The tradeoff is real and worth exposing rather than
// picking for the user: frequency resolution is 1/window, so a 15s scan can only
// place the pulse peak to about ±4 BPM before any noise is considered, while a
// longer window also averages down the motion and lighting artifacts that
// dominate webcam rPPG. 30s is what ubicomplab/rppg-web and the TS-CAN paper use,
// so it stays the default.
export const SCAN_DURATION_OPTIONS = [15, 30, 60] as const;
export type ScanDurationSec = (typeof SCAN_DURATION_OPTIONS)[number];
export const DEFAULT_SCAN_DURATION: ScanDurationSec = 30;

/** Minimum usable samples, scaled to the window: roughly 4 seconds of capture at
 * a conservative 20fps. A fixed floor would either reject a valid 15s scan or wave
 * through a 60s one that lost most of its frames. */
const minUsableSamples = (durationSec: number) => Math.round(durationSec * 20 * 0.2);
const WAVEFORM_POINTS = 150;

// Everything downstream is resampled onto this grid, so the bandpass and FFT see
// evenly spaced samples whatever the camera actually delivered. 30Hz is the rate
// TS-CAN was trained and evaluated at.
const ANALYSIS_FPS = 30;

const MODEL_LOAD_TIMEOUT_MS = 8_000;

export type HeartPulseScanPhase = "idle" | "aligning" | "scanning" | "analyzing" | "done" | "error";
/** "tscan" is the UW TS-CAN network; "pos" is the classical fallback. */
export type HeartPulseEngine = "tscan" | "pos";

export interface HeartPulseScanState {
  phase: HeartPulseScanPhase;
  /** 0-1 progress through the scan window. */
  progress: number;
  waveform: number[];
  result: HeartPulseResult | null;
  errorMessage: string;
  /** Which signal source actually produced the result — surfaced so the UI
   * can be transparent about a fallback happening. */
  engine: HeartPulseEngine | null;
  /** Whether the neck (carotid) region was visible skin often enough to be
   * folded into the signal. Reported so the guidance can be honest about
   * whether it actually contributed. */
  neckUsed: boolean;
}

export function useHeartPulseScan() {
  const [state, setState] = useState<HeartPulseScanState>({
    phase: "idle",
    progress: 0,
    waveform: [],
    result: null,
    errorMessage: "",
    engine: null,
    neckUsed: false,
  });

  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** RGB region means, kept for the POS fallback. Cheap, and it means the
   * fallback needs no second pass over the video. */
  const samplesRef = useRef<RgbSample[]>([]);
  /** Face crops awaiting inference, with the timestamp of each. */
  const pendingRef = useRef<{ frames: RgbFrame[]; times: number[] }>({ frames: [], times: [] });
  /** The frame before the pending window, so windows chain without dropping a
   * sample at each boundary. */
  const previousFrameRef = useRef<RgbFrame | null>(null);
  /** Model output so far: one pulse-derivative value per frame, plus its time. */
  const pulseRef = useRef<{ derivative: number[]; times: number[] }>({ derivative: [], times: [] });
  const inferenceBusyRef = useRef(false);
  const modelRef = useRef<Awaited<ReturnType<typeof loadTsCanModel>> | null>(null);
  const motionRef = useRef<{ totalDisplacement: number; sampleCount: number }>({
    totalDisplacement: 0,
    sampleCount: 0,
  });
  const lastCenterRef = useRef<{ x: number; y: number } | null>(null);
  const lastVideoTimeRef = useRef(-1);
  const scanStartRef = useRef<number>(0);
  const durationRef = useRef<number>(DEFAULT_SCAN_DURATION);
  /** How many frames actually had usable neck skin, so the UI can say whether it
   * contributed rather than assuming it did. */
  const neckFramesRef = useRef({ used: 0, total: 0 });

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stop();
    setState({
      phase: "idle",
      progress: 0,
      waveform: [],
      result: null,
      errorMessage: "",
      engine: null,
      neckUsed: false,
    });
  }, [stop]);

  /**
   * Runs whatever whole windows are buffered, one at a time.
   *
   * Called from the capture loop but never awaited there: inference must not
   * throttle frame collection, because a dropped frame is a hole in the signal.
   * `inferenceBusyRef` keeps a single pump running instead of piling up
   * concurrent predicts on one WebGL context.
   */
  const pumpInference = useCallback(async () => {
    if (inferenceBusyRef.current) return;
    const model = modelRef.current;
    if (!model) return;
    inferenceBusyRef.current = true;
    try {
      while (pendingRef.current.frames.length >= TSCAN_WINDOW) {
        const frames = pendingRef.current.frames.splice(0, TSCAN_WINDOW);
        const times = pendingRef.current.times.splice(0, TSCAN_WINDOW);
        const previous = previousFrameRef.current;
        const values = await runTsCanWindow(model, frames, previous);
        // Without a seed frame the first sample funds the difference, so the
        // outputs line up with the TAIL of the window's timestamps.
        const offset = times.length - values.length;
        pulseRef.current.derivative.push(...values);
        pulseRef.current.times.push(...times.slice(offset));
        previousFrameRef.current = frames[frames.length - 1];
      }
    } catch (err) {
      console.warn("TS-CAN inference failed; the POS fallback will be used:", err);
      modelRef.current = null;
    } finally {
      inferenceBusyRef.current = false;
    }
  }, []);

  const finish = useCallback(() => {
    stop();
    setState((s) => ({ ...s, phase: "analyzing" }));

    void (async () => {
      const samples = samplesRef.current;
      const minSamples = minUsableSamples(durationRef.current);
      if (samples.length < minSamples) {
        setState((s) => ({
          ...s,
          phase: "error",
          errorMessage: "측정 신호가 충분하지 않습니다. 얼굴이 가이드 안에 계속 보이도록 하고 다시 시도해주세요.",
        }));
        return;
      }

      try {
        // Drain the frames captured after the last pump.
        await pumpInference();

        let signal: number[] | null = null;
        let engine: HeartPulseEngine = "pos";

        const { derivative, times } = pulseRef.current;
        if (modelRef.current && derivative.length >= minSamples) {
          // The model emits the pulse derivative, so integrate first, then put it
          // on a uniform time base before any spectral work.
          signal = resampleUniform(integratePulse(derivative), times, ANALYSIS_FPS);
          engine = "tscan";
        }

        if (!signal) {
          // POS on the region means. Resampled the same way so both engines feed
          // the downstream stage identical assumptions.
          const posTimes = samples.map((s) => s.t);
          const totalSeconds = (posTimes[posTimes.length - 1] - posTimes[0]) / 1000;
          const posFps = totalSeconds > 0 ? samples.length / totalSeconds : ANALYSIS_FPS;
          signal = resampleUniform(posSignalFromRgbSeries(samples, posFps), posTimes, ANALYSIS_FPS);
          engine = "pos";
        }

        const filtered = bandpassFilter(signal, ANALYSIS_FPS);
        const { bpm, sdnn, rmssd, stressIndex, snrDb, beatsDetected, cleanBeats } = estimateBpmAndHrv(
          filtered,
          ANALYSIS_FPS
        );

        const avgMotion =
          motionRef.current.sampleCount > 0
            ? motionRef.current.totalDisplacement / motionRef.current.sampleCount
            : 0;
        // Confidence blends two real quality signals — how cleanly the beats
        // survived artifact rejection (retention) and the spectral SNR of the
        // pulse peak — then attenuates by head motion.
        const retention = beatsDetected > 0 ? Math.min(1, cleanBeats / beatsDetected) : 0;
        const snr01 = Math.max(0, Math.min(1, (snrDb + 8) / 16)); // -8dB→0, +8dB→1
        const quality = 0.6 * retention + 0.4 * snr01;
        const motionFactor = 1 - Math.min(0.4, avgMotion * 0.05);
        const confidence = Math.max(0, Math.round(100 * quality * motionFactor));

        const result: HeartPulseResult = {
          bpm: Math.min(220, Math.max(35, Math.round(bpm))),
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

        const neck = neckFramesRef.current;
        setState((s) => ({
          ...s,
          phase: "done",
          progress: 1,
          result,
          engine,
          // "Used" only if it was visible for most of the scan; a couple of lucky
          // frames shouldn't let the UI claim the neck contributed.
          neckUsed: neck.total > 0 && neck.used / neck.total >= 0.5,
        }));
      } catch (err) {
        console.error("rPPG analysis failed:", err);
        setState((s) => ({
          ...s,
          phase: "error",
          errorMessage: "측정 분석 중 오류가 발생했습니다. 다시 시도해주세요.",
        }));
      }
    })();
  }, [pumpInference, stop]);

  const start = useCallback(
    async (video: HTMLVideoElement, durationSec: ScanDurationSec = DEFAULT_SCAN_DURATION) => {
      stop();
      durationRef.current = durationSec;
      neckFramesRef.current = { used: 0, total: 0 };
      samplesRef.current = [];
      pendingRef.current = { frames: [], times: [] };
      pulseRef.current = { derivative: [], times: [] };
      previousFrameRef.current = null;
      inferenceBusyRef.current = false;
      motionRef.current = { totalDisplacement: 0, sampleCount: 0 };
      lastCenterRef.current = null;
      lastVideoTimeRef.current = -1;
      setState({
        phase: "aligning",
        progress: 0,
        waveform: [],
        result: null,
        errorMessage: "",
        engine: null,
        neckUsed: false,
      });

      // Start the model load in parallel with the face landmarker so it has the
      // alignment period to finish rather than only starting once scanning does.
      const modelLoad = withTimeout(loadTsCanModel(), MODEL_LOAD_TIMEOUT_MS)
        .then((model) => {
          modelRef.current = model;
        })
        .catch((err) => {
          console.warn("TS-CAN model unavailable, falling back to POS:", err);
          modelRef.current = null;
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
      void modelLoad;

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

        // Only sample when the camera has actually produced a new frame. rAF can
        // run at 60Hz+ against a 30fps camera, and re-reading the same frame
        // would inject duplicate samples — a flat stretch in the waveform that
        // pulls the spectrum toward DC and biases the estimate.
        if (video.currentTime === lastVideoTimeRef.current) {
          rafRef.current = requestAnimationFrame(loop);
          return;
        }
        lastVideoTimeRef.current = video.currentTime;

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
        const patches = [forehead, leftCheek, rightCheek];

        // The neck (carotid) region, folded in ONLY when it's really exposed skin
        // inside the frame. The carotids run close to the surface so the pulsatile
        // component there is strong, but a collar, a beard or a tight framing puts
        // it out of reach — and averaging a shirt into the signal is worse than
        // leaving it out. Skin-masked so the check is on pixels, not hope.
        const neckSample = sampleRegionSkinMean(ctx, regions.neck, canvas.width, canvas.height);
        const neckUsable = isRegionUsableSkin(regions.neck, neckSample, canvas.width, canvas.height);
        neckFramesRef.current.total += 1;
        if (neckUsable) {
          neckFramesRef.current.used += 1;
          patches.push(neckSample);
        }

        const r = patches.reduce((sum, p) => sum + p.r, 0) / patches.length;
        const g = patches.reduce((sum, p) => sum + p.g, 0) / patches.length;
        const b = patches.reduce((sum, p) => sum + p.b, 0) / patches.length;

        // The model's own ROI: a tracked face crop at 36x36. The upstream demo
        // uses a FIXED box and asks the user to line their face up inside it; we
        // have landmarks, so the crop follows the face instead — the same input
        // the network was trained on, minus the alignment burden.
        const faceCropBox = computeFaceCropBox(landmarks, canvas.width, canvas.height);
        const faceCrop = sampleRegionAsRgbFrame(video, faceCropBox, cropCanvas, TSCAN_IMG_SIZE);

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
        pendingRef.current.frames.push(faceCrop);
        pendingRef.current.times.push(elapsed);
        // Not awaited: inference runs alongside capture so there's no long stall
        // at the end of the scan.
        void pumpInference();

        setState((s) => {
          const nextWaveform = [...s.waveform, g];
          return {
            ...s,
            progress: Math.min(1, elapsed / (durationSec * 1000)),
            waveform:
              nextWaveform.length > WAVEFORM_POINTS
                ? nextWaveform.slice(nextWaveform.length - WAVEFORM_POINTS)
                : nextWaveform,
          };
        });

        if (elapsed >= durationSec * 1000) {
          finish();
          return;
        }
        rafRef.current = requestAnimationFrame(loop);
      };

      rafRef.current = requestAnimationFrame(loop);
    },
    [finish, pumpInference, stop]
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
