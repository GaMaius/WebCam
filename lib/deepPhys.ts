// Runs the pretrained DeepPhys model (ubicomplab/rPPG-Toolbox,
// final_model_release/PURE_DeepPhys.pth, converted to ONNX — see
// docs/models/deepphys.md for the conversion + verification notes) in
// -browser via onnxruntime-web. This is the "real deep-learning" rPPG
// path; POS (lib/pos.ts) is the fallback when the model can't be loaded
// (offline, slow network, unsupported environment).
//
// Preprocessing is a line-for-line port of BaseLoader.diff_normalize_data /
// standardized_data from the same toolbox (dataset/data_loader/BaseLoader.py):
// whole-clip normalization, not per-frame — matches how the checkpoint was
// trained. The inference config this checkpoint ships with
// (configs/infer_configs/PURE_UBFC-rPPG_DEEPPHYS_BASIC.yaml) specifies a
// 72x72 face crop enlarged 1.5x around the detected face box; see
// lib/roi.ts's computeFaceCropBox for the matching crop logic.

import * as ort from "onnxruntime-web";

const ORT_VERSION = "1.27.0";
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

const MODEL_URL = "/models/deepphys-pure.onnx";
export const DEEPPHYS_IMG_SIZE = 72;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

export function loadDeepPhysSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["wasm"],
    });
    sessionPromise.catch(() => {
      sessionPromise = null; // allow a retry later
    });
  }
  return sessionPromise;
}

/** One 72x72 RGB frame as a flat, channel-last Float32Array of length 72*72*3. */
export type RgbFrame = Float32Array;

/**
 * Port of BaseLoader.diff_normalize_data: per-adjacent-frame-pair
 * normalized difference, then divided by the WHOLE clip's standard
 * deviation, with a trailing zero-padding frame so the output length
 * matches the input length.
 */
export function diffNormalizeFrames(frames: RgbFrame[]): RgbFrame[] {
  const n = frames.length;
  if (n === 0) return [];
  const frameLen = frames[0].length;
  const diffLen = n - 1;

  const diffs: Float32Array[] = new Array(diffLen);
  for (let j = 0; j < diffLen; j++) {
    const cur = frames[j];
    const next = frames[j + 1];
    const out = new Float32Array(frameLen);
    for (let i = 0; i < frameLen; i++) {
      out[i] = (next[i] - cur[i]) / (next[i] + cur[i] + 1e-7);
    }
    diffs[j] = out;
  }

  const std = stdDevAcrossFrames(diffs);
  for (let j = 0; j < diffLen; j++) {
    const out = diffs[j];
    for (let i = 0; i < frameLen; i++) {
      const v = std === 0 ? 0 : out[i] / std;
      out[i] = Number.isNaN(v) ? 0 : v;
    }
  }

  const padding = new Float32Array(frameLen); // all zeros
  return [...diffs, padding];
}

/** Port of BaseLoader.standardized_data: whole-clip z-score normalization. */
export function standardizeFrames(frames: RgbFrame[]): RgbFrame[] {
  const n = frames.length;
  if (n === 0) return [];
  const frameLen = frames[0].length;

  let sum = 0;
  for (const f of frames) for (let i = 0; i < frameLen; i++) sum += f[i];
  const total = n * frameLen;
  const mean = sum / total;

  let sqSum = 0;
  for (const f of frames) for (let i = 0; i < frameLen; i++) sqSum += (f[i] - mean) ** 2;
  const std = Math.sqrt(sqSum / total);

  return frames.map((f) => {
    const out = new Float32Array(frameLen);
    for (let i = 0; i < frameLen; i++) {
      const v = std === 0 ? 0 : (f[i] - mean) / std;
      out[i] = Number.isNaN(v) ? 0 : v;
    }
    return out;
  });
}

function stdDevAcrossFrames(frames: Float32Array[]): number {
  const n = frames.length;
  if (n === 0) return 0;
  const frameLen = frames[0].length;
  const total = n * frameLen;

  let sum = 0;
  for (const f of frames) for (let i = 0; i < frameLen; i++) sum += f[i];
  const mean = sum / total;

  let sqSum = 0;
  for (const f of frames) for (let i = 0; i < frameLen; i++) sqSum += (f[i] - mean) ** 2;
  return Math.sqrt(sqSum / total);
}

/** Converts a channel-last (H*W*3) frame into the model's expected
 * channel-first (3*H*W) layout. */
function toChannelFirst(frame: RgbFrame, size: number): Float32Array {
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let p = 0; p < plane; p++) {
    out[p] = frame[p * 3]; // R
    out[plane + p] = frame[p * 3 + 1]; // G
    out[2 * plane + p] = frame[p * 3 + 2]; // B
  }
  return out;
}

/**
 * Runs the model once per frame index (diff-normalized + standardized
 * frame pairs), returning a raw signal the same length as the input clip
 * — this is the DL analogue of pos.ts's output and is meant to be fed into
 * the same bandpassFilter/estimateBpmAndHrv pipeline.
 */
export async function runDeepPhysInference(
  session: ort.InferenceSession,
  rawFrames: RgbFrame[],
  size = DEEPPHYS_IMG_SIZE
): Promise<number[]> {
  const diffFrames = diffNormalizeFrames(rawFrames);
  const stdFrames = standardizeFrames(rawFrames);
  const n = rawFrames.length;
  const plane = size * size;

  const output = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const diffCHW = toChannelFirst(diffFrames[i], size);
    const stdCHW = toChannelFirst(stdFrames[i], size);
    const combined = new Float32Array(6 * plane);
    combined.set(diffCHW, 0);
    combined.set(stdCHW, 3 * plane);

    const tensor = new ort.Tensor("float32", combined, [1, 6, size, size]);
    const results = await session.run({ input: tensor });
    output[i] = results.output.data[0] as number;
  }
  return output;
}
