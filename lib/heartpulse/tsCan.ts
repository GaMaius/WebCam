// TS-CAN pulse extraction, ported from ubicomplab/rppg-web (UW Ubicomp Lab).
//
// Replaces the DeepPhys ONNX path. Same lab, later paper: TS-CAN adds temporal
// shift modules and soft attention on top of the DeepPhys idea, and the vendored
// weights are the ones the lab ships in its public demo
// (vitals.cs.washington.edu). POS stays as the fallback when this can't run.
//
// The two model inputs are NOT interchangeable, and the normalization below is
// reproduced from the reference exactly — the network was trained on these
// statistics, so "equivalent" alternatives (per-channel std, /255 without the
// clip, mean over the batch instead of the frame) change what it sees:
//
//   motion     = (frame - previousFrame) / (frame + previousFrame), divided by the
//                standard deviation of that whole tensor.
//   appearance = (frame - mean(frame)), divided by its own standard deviation.
//
// Both start from the frame scaled to [0,1] and clipped to [1/255, 1]; the clip is
// what keeps the motion denominator away from zero in black pixels.

import type * as tfTypes from "@tensorflow/tfjs";
import { registerTsCanLayers } from "./tsCanLayers.ts";

/** Model input side length. The vendored model.json declares [None,36,36,3]. */
export const TSCAN_IMG_SIZE = 36;

/** Frames per inference window. The batch dimension IS time for TSM, so this is
 * the temporal window, and it must match what the model was exported with. */
export const TSCAN_WINDOW = 10;

/** One frame as interleaved RGB in [0,255], length size*size*3. */
export type RgbFrame = Float32Array;

const MODEL_URL = "/models/tscan/model.json";

type Tf = typeof tfTypes;

let tfPromise: Promise<Tf> | null = null;
let modelPromise: Promise<tfTypes.LayersModel> | null = null;

/** Loads tfjs on demand — it's large, and only this app needs it. */
async function loadTf(): Promise<Tf> {
  if (!tfPromise) {
    tfPromise = import("@tensorflow/tfjs").then(async (tf) => {
      // WebGL is the fast path; CPU still works, just slowly, so a machine
      // without WebGL degrades instead of failing.
      try {
        await tf.setBackend("webgl");
      } catch {
        await tf.setBackend("cpu");
      }
      await tf.ready();
      return tf;
    });
    tfPromise.catch(() => {
      tfPromise = null;
    });
  }
  return tfPromise;
}

/** Loads (and caches) the TS-CAN model. */
export function loadTsCanModel(): Promise<tfTypes.LayersModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const tf = await loadTf();
      registerTsCanLayers(tf);
      return tf.loadLayersModel(MODEL_URL);
    })();
    modelPromise.catch(() => {
      modelPromise = null;
    });
  }
  return modelPromise;
}

/**
 * Builds the model's two inputs for one window of consecutive frames.
 *
 * `previous` is the frame before the window starts, so windows can be chained
 * without dropping a sample at every boundary — the reference keeps a rolling
 * `previousFrame` for exactly this reason. Without one, the first frame of the
 * window is consumed to seed the difference.
 *
 * Pure numeric work on plain arrays, so tests can check it against hand-computed
 * statistics with no GPU and no model.
 */
export function buildWindowInputs(
  frames: RgbFrame[],
  previous: RgbFrame | null,
  size = TSCAN_IMG_SIZE
): { motion: Float32Array; appearance: Float32Array; count: number } | null {
  const pixels = size * size * 3;
  const startIndex = previous ? 0 : 1;
  const count = frames.length - startIndex;
  if (count < 1) return null;

  const motion = new Float32Array(count * pixels);
  const appearance = new Float32Array(count * pixels);

  for (let i = 0; i < count; i++) {
    const index = startIndex + i;
    const current = frames[index];
    const prior = index === 0 ? previous! : frames[index - 1];
    const offset = i * pixels;

    // Motion: normalized frame difference, then scaled by its own std.
    for (let p = 0; p < pixels; p++) {
      const c = clip01(current[p] / 255);
      const q = clip01(prior[p] / 255);
      motion[offset + p] = (c - q) / (c + q);
    }
    divideByStd(motion, offset, pixels);

    // Appearance: the frame itself, mean-removed and scaled by its own std.
    let mean = 0;
    for (let p = 0; p < pixels; p++) mean += clip01(current[p] / 255);
    mean /= pixels;
    for (let p = 0; p < pixels; p++) appearance[offset + p] = clip01(current[p] / 255) - mean;
    divideByStd(appearance, offset, pixels);
  }

  return { motion, appearance, count };
}

/** The reference clips to [1/255, 1] after dividing by 255, which keeps the
 * motion branch's (current + previous) denominator off zero. */
function clip01(value: number): number {
  return Math.min(1, Math.max(1 / 255, value));
}

/**
 * Divides a slice in place by its standard deviation.
 *
 * Population std over the WHOLE slice — all pixels and all three channels
 * together — matching the reference's `moments(t).variance.sqrt()`. Per-channel
 * instead would rescale the colour ratios the pulse actually lives in.
 */
function divideByStd(data: Float32Array, offset: number, length: number): void {
  let mean = 0;
  for (let p = 0; p < length; p++) mean += data[offset + p];
  mean /= length;
  let variance = 0;
  for (let p = 0; p < length; p++) {
    const d = data[offset + p] - mean;
    variance += d * d;
  }
  variance /= length;
  const std = Math.sqrt(variance);
  if (std < 1e-12) return; // a perfectly flat frame: leave it as zeros
  for (let p = 0; p < length; p++) data[offset + p] /= std;
}

/**
 * Runs the model over one window and returns its per-frame outputs.
 *
 * The output is the pulse DERIVATIVE — the network predicts the first difference
 * of the PPG waveform — so callers accumulate it (see `integratePulse`).
 */
export async function runTsCanWindow(
  model: tfTypes.LayersModel,
  frames: RgbFrame[],
  previous: RgbFrame | null,
  size = TSCAN_IMG_SIZE
): Promise<number[]> {
  const inputs = buildWindowInputs(frames, previous, size);
  if (!inputs) return [];
  const tf = await loadTf();

  const motion = tf.tensor4d(inputs.motion, [inputs.count, size, size, 3]);
  const appearance = tf.tensor4d(inputs.appearance, [inputs.count, size, size, 3]);
  try {
    const prediction = model.predict([motion, appearance]) as tfTypes.Tensor;
    try {
      return Array.from(await prediction.data());
    } finally {
      prediction.dispose();
    }
  } finally {
    motion.dispose();
    appearance.dispose();
  }
}

/**
 * Turns the model's per-frame derivative output into a pulse waveform.
 *
 * Cumulative sum, then mean-removed so the downstream bandpass isn't fighting a
 * large DC offset. The reference does the same cumsum before its bandpass; the
 * mean removal is ours and only affects conditioning.
 */
export function integratePulse(derivative: number[]): number[] {
  const out: number[] = [];
  let running = 0;
  for (const d of derivative) {
    running += d;
    out.push(running);
  }
  const mean = out.reduce((a, b) => a + b, 0) / (out.length || 1);
  return out.map((v) => v - mean);
}
