import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as tf from "@tensorflow/tfjs";
import { registerTsCanLayers } from "../lib/heartpulse/tsCanLayers.ts";
import {
  buildWindowInputs,
  integratePulse,
  TSCAN_IMG_SIZE,
  TSCAN_WINDOW,
} from "../lib/heartpulse/tsCan.ts";
import { resampleUniform, analyzeSpectrum } from "../lib/signalProcessing.ts";

const MODEL_DIR = path.join(process.cwd(), "public", "models", "tscan");
const PIXELS = TSCAN_IMG_SIZE * TSCAN_IMG_SIZE * 3;

/**
 * Loads the real vendored model from disk.
 *
 * tfjs's filesystem IO handler lives in tfjs-node, which we don't install, so
 * this hands `loadLayersModel` a hand-rolled IOHandler instead. Worth the twenty
 * lines: the whole point is to check the actual weights file we ship, not a
 * stand-in — the upstream repo registers its attention layer under a name its own
 * model.json doesn't use, and only really loading the file catches that.
 */
async function loadRealModel(): Promise<tf.LayersModel> {
  registerTsCanLayers(tf);
  const modelJson = JSON.parse(await readFile(path.join(MODEL_DIR, "model.json"), "utf8"));
  const shardNames: string[] = modelJson.weightsManifest.flatMap(
    (group: { paths: string[] }) => group.paths
  );
  const shards = await Promise.all(
    shardNames.map((name) => readFile(path.join(MODEL_DIR, name)))
  );
  const total = shards.reduce((sum, s) => sum + s.byteLength, 0);
  const weightData = new Uint8Array(total);
  let at = 0;
  for (const shard of shards) {
    weightData.set(new Uint8Array(shard.buffer, shard.byteOffset, shard.byteLength), at);
    at += shard.byteLength;
  }
  const weightSpecs = modelJson.weightsManifest.flatMap(
    (group: { weights: unknown[] }) => group.weights
  );
  return tf.loadLayersModel({
    load: async () => ({
      modelTopology: modelJson.modelTopology,
      weightSpecs: weightSpecs as never,
      weightData: weightData.buffer,
    }),
  });
}

/** A frame of uniform grey, plus an optional per-pixel delta. */
function frame(base: number, delta = 0): Float32Array {
  const f = new Float32Array(PIXELS);
  for (let i = 0; i < PIXELS; i++) f[i] = base + delta * Math.sin(i * 0.37);
  return f;
}

test("the shipped model loads with the layer names its own JSON declares", async () => {
  // The upstream repo registers `AttentionMask` while its model.json says
  // `Attention_mask`. If tsCanLayers is ever "corrected" to the class name, this
  // fails here rather than in a user's browser.
  const model = await loadRealModel();
  assert.equal(model.inputs.length, 2, "TS-CAN takes motion + appearance");
  for (const input of model.inputs) {
    assert.deepEqual(input.shape, [null, TSCAN_IMG_SIZE, TSCAN_IMG_SIZE, 3]);
  }
  assert.equal(model.outputs.length, 1);
  // One scalar per frame: this is the pulse-only TS-CAN, not the 2-output
  // multi-task variant, so there's no respiration head to read.
  assert.deepEqual(model.outputs[0].shape, [null, 1]);
  model.dispose();
});

test("the real model turns a window of frames into one value per frame", async () => {
  const model = await loadRealModel();
  const frames = Array.from({ length: TSCAN_WINDOW }, (_, i) => frame(120, 4 + i));
  const inputs = buildWindowInputs(frames, frame(120, 3));
  assert.ok(inputs);
  assert.equal(inputs!.count, TSCAN_WINDOW, "a seeded window keeps every frame");

  const motion = tf.tensor4d(inputs!.motion, [TSCAN_WINDOW, TSCAN_IMG_SIZE, TSCAN_IMG_SIZE, 3]);
  const appearance = tf.tensor4d(inputs!.appearance, [
    TSCAN_WINDOW,
    TSCAN_IMG_SIZE,
    TSCAN_IMG_SIZE,
    3,
  ]);
  const prediction = model.predict([motion, appearance]) as tf.Tensor;
  const values = Array.from(await prediction.data());

  assert.equal(values.length, TSCAN_WINDOW);
  assert.ok(
    values.every((v) => Number.isFinite(v)),
    `every output must be finite, got ${JSON.stringify(values)}`
  );
  // A constant output would mean the temporal shift isn't reaching the head —
  // the failure mode if TSM's window/batch wiring is wrong.
  assert.ok(
    new Set(values.map((v) => v.toFixed(6))).size > 1,
    "outputs should vary across the window"
  );

  tf.dispose([motion, appearance, prediction]);
  model.dispose();
});

test("a window without a seed frame spends one frame on the difference", () => {
  const frames = Array.from({ length: TSCAN_WINDOW }, (_, i) => frame(100, i));
  assert.equal(buildWindowInputs(frames, null)!.count, TSCAN_WINDOW - 1);
  // Chaining windows with a carried-over previous frame loses nothing, which is
  // why the hook keeps one.
  assert.equal(buildWindowInputs(frames, frame(100, -1))!.count, TSCAN_WINDOW);
  assert.equal(buildWindowInputs([frame(100)], null), null);
});

test("both inputs are standardized to unit variance per frame", () => {
  // The network was trained on these statistics. Anything that changes the scale
  // — per-channel std, a missing clip — silently changes what it sees, and the
  // output stays plausible-looking, so this is worth pinning.
  const frames = [frame(90, 12), frame(95, 9), frame(88, 15)];
  const inputs = buildWindowInputs(frames, frame(92, 10))!;
  for (let i = 0; i < inputs.count; i++) {
    for (const data of [inputs.motion, inputs.appearance]) {
      const slice = data.subarray(i * PIXELS, (i + 1) * PIXELS);
      const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
      const variance =
        slice.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / slice.length;
      assert.ok(
        Math.abs(Math.sqrt(variance) - 1) < 1e-3,
        `frame ${i} should have unit std, got ${Math.sqrt(variance).toFixed(4)}`
      );
    }
  }
});

test("a flat frame yields zeros instead of NaN", () => {
  // Dividing by a zero std is the obvious way to poison the whole signal: one
  // NaN propagates through the cumulative sum and the FFT and takes the reading
  // with it. A covered lens or a fully blown-out frame is a real case.
  const inputs = buildWindowInputs([frame(0), frame(0)], frame(0))!;
  assert.ok(inputs.motion.every((v) => Number.isFinite(v)));
  assert.ok(inputs.appearance.every((v) => Number.isFinite(v)));
});

test("integratePulse accumulates the derivative and removes the offset", () => {
  // The model predicts the DERIVATIVE of the pulse, so a constant-ish output is a
  // ramp, not a level. Forgetting the cumsum leaves the pulse frequency doubled
  // and shifted, which looks like a plausible-but-wrong BPM.
  const pulse = integratePulse([1, 1, 1, -1, -1, -1]);
  const mean = pulse.reduce((a, b) => a + b, 0) / pulse.length;
  assert.ok(Math.abs(mean) < 1e-12, "the result should be mean-centred");
  assert.equal(pulse.length, 6);
  // Rising then falling, as the derivative says.
  assert.ok(pulse[2] > pulse[0]);
  assert.ok(pulse[5] < pulse[2]);
});

test("resampling recovers the right rate from jittery frame times", () => {
  // A 72 BPM pulse (1.2 Hz) sampled at wobbling intervals. Reading it as if the
  // samples were evenly spaced is what smears the peak; this is the fix.
  const trueBpm = 72;
  const hz = trueBpm / 60;
  const times: number[] = [];
  const values: number[] = [];
  let t = 0;
  for (let i = 0; i < 600; i++) {
    // Mean ~30fps, but every third frame arrives late — a browser under load.
    t += i % 3 === 0 ? 50 : 25;
    times.push(t);
    values.push(Math.sin(2 * Math.PI * hz * (t / 1000)));
  }
  const meanFps = (values.length - 1) / ((t - times[0]) / 1000);

  const naive = analyzeSpectrum(values, meanFps).bpm;
  const resampled = analyzeSpectrum(resampleUniform(values, times, 30), 30).bpm;

  assert.ok(
    Math.abs(resampled - trueBpm) < Math.abs(naive - trueBpm) ||
      Math.abs(resampled - trueBpm) < 1.5,
    `resampled (${resampled.toFixed(1)}) should beat naive (${naive.toFixed(1)}) ` +
      `against ${trueBpm}`
  );
  assert.ok(
    Math.abs(resampled - trueBpm) < 2,
    `resampled BPM should land within 2 of truth, got ${resampled.toFixed(1)}`
  );
});

test("resampling is a no-op on degenerate input rather than throwing", () => {
  assert.deepEqual(resampleUniform([1], [0], 30), [1]);
  assert.deepEqual(resampleUniform([], [], 30), []);
  // All samples at the same instant: no duration to resample over.
  assert.deepEqual(resampleUniform([1, 2], [5, 5], 30), [1, 2]);
});
