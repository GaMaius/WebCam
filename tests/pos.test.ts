import test from "node:test";
import assert from "node:assert/strict";
import { posSignalFromRgbSeries, type RgbSample } from "../lib/pos.ts";

const FPS = 30;

test("posSignalFromRgbSeries returns an empty array for no samples", () => {
  assert.deepEqual(posSignalFromRgbSeries([], FPS), []);
});

test("posSignalFromRgbSeries returns an all-zero signal for a perfectly static input", () => {
  // 100 samples at 30fps = ~3.3s, comfortably longer than the 1.6s sliding
  // window so several window positions are actually evaluated.
  const samples: RgbSample[] = Array.from({ length: 100 }, (_, i) => ({ t: i * 33, r: 150, g: 160, b: 140 }));
  const signal = posSignalFromRgbSeries(samples, FPS);
  assert.equal(signal.length, 100);
  for (const v of signal) {
    assert.ok(Math.abs(v) < 1e-9, `expected ~0 for constant input, got ${v}`);
  }
});

test("posSignalFromRgbSeries responds to a periodic green-channel pulsation", () => {
  const n = 300; // 10s at 30fps — several full pulsation cycles and window slides
  const samples: RgbSample[] = Array.from({ length: n }, (_, i) => {
    const pulse = Math.sin((2 * Math.PI * i) / 25); // synthetic pulsation
    return {
      t: i * 33,
      r: 150,
      g: 160 + pulse * 3, // green carries most of the blood-volume signal
      b: 140,
    };
  });

  const signal = posSignalFromRgbSeries(samples, FPS);
  assert.equal(signal.length, n);
  const spread = Math.max(...signal) - Math.min(...signal);
  assert.ok(spread > 0.001, `expected the POS signal to vary with input pulsation, spread was ${spread}`);
});

test("posSignalFromRgbSeries's very last sample is always left at zero", () => {
  // Reference semantics: window n covers indices [n-windowLen, n), so the
  // first valid window (n=windowLen) already covers indices
  // [0, windowLen) — the *first* samples ARE covered. The one index no
  // window ever reaches is the very last one (N-1), since the largest
  // valid n is N-1, covering only up to index N-2.
  const n = 200;
  const samples: RgbSample[] = Array.from({ length: n }, (_, i) => ({
    t: i * 33,
    r: 150 + Math.sin(i / 5) * 5,
    g: 160 + Math.sin(i / 5) * 8,
    b: 140 + Math.sin(i / 5) * 3,
  }));
  const signal = posSignalFromRgbSeries(samples, FPS);
  assert.equal(signal[n - 1], 0, "expected the final sample to be untouched by any window");

  // And earlier samples (including the very first ones, covered by the
  // first valid window) should receive real contributions given the
  // varying input.
  const earlierNonZero = signal.slice(0, n - 1).some((v) => Math.abs(v) > 1e-9);
  assert.ok(earlierNonZero, "expected samples before the last one to receive contributions");
});

test("posSignalFromRgbSeries stays bounded under a slow overall brightness drift", () => {
  // This is the sliding-window design's whole reason for existing: a scene
  // that gradually brightens over the clip (simulating auto-exposure/
  // auto-white-balance drift) should NOT blow up the projected signal's
  // amplitude, because each 1.6s window only ever normalizes against its
  // own local mean — not the full clip's mean, which the drift would skew.
  const n = 300; // 10s at 30fps
  const samples: RgbSample[] = Array.from({ length: n }, (_, i) => {
    const pulse = Math.sin((2 * Math.PI * i) / 25);
    const drift = i * 0.6; // steadily brightening scene across the whole clip
    return {
      t: i * 33,
      r: 150 + drift,
      g: 160 + drift + pulse * 3,
      b: 140 + drift,
    };
  });

  const withDrift = posSignalFromRgbSeries(samples, FPS);
  const withoutDrift = posSignalFromRgbSeries(
    samples.map((s, i) => ({ ...s, r: s.r - i * 0.6, g: s.g - i * 0.6, b: s.b - i * 0.6 })),
    FPS
  );

  const spreadWithDrift = Math.max(...withDrift) - Math.min(...withDrift);
  const spreadWithoutDrift = Math.max(...withoutDrift) - Math.min(...withoutDrift);

  // The two should be close (drift shouldn't meaningfully change the
  // recovered pulsation's amplitude), not wildly different.
  assert.ok(
    Math.abs(spreadWithDrift - spreadWithoutDrift) < spreadWithoutDrift * 0.5,
    `expected drift to leave the signal's amplitude roughly unchanged: with=${spreadWithDrift}, without=${spreadWithoutDrift}`
  );
});
