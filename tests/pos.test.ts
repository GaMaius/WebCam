import test from "node:test";
import assert from "node:assert/strict";
import { posSignalFromRgbSeries, type RgbSample } from "../lib/pos.ts";

test("posSignalFromRgbSeries returns an empty array for no samples", () => {
  assert.deepEqual(posSignalFromRgbSeries([]), []);
});

test("posSignalFromRgbSeries returns a flat (near-zero) signal for a perfectly static input", () => {
  const samples: RgbSample[] = Array.from({ length: 30 }, (_, i) => ({ t: i * 33, r: 150, g: 160, b: 140 }));
  const signal = posSignalFromRgbSeries(samples);
  assert.equal(signal.length, 30);
  for (const v of signal) {
    assert.ok(Math.abs(v) < 1e-9, `expected ~0 for constant input, got ${v}`);
  }
});

test("posSignalFromRgbSeries responds to a periodic green-channel pulsation", () => {
  const n = 150;
  const samples: RgbSample[] = Array.from({ length: n }, (_, i) => {
    const pulse = Math.sin((2 * Math.PI * i) / 25); // synthetic ~1Hz-ish pulsation at 30fps-equivalent spacing
    return {
      t: i * 33,
      r: 150,
      g: 160 + pulse * 3, // green carries most of the blood-volume signal
      b: 140,
    };
  });

  const signal = posSignalFromRgbSeries(samples);
  assert.equal(signal.length, n);
  // The projected signal should vary (not be constant) when the input pulsates.
  const spread = Math.max(...signal) - Math.min(...signal);
  assert.ok(spread > 0.001, `expected the POS signal to vary with input pulsation, spread was ${spread}`);
});
