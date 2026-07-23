import test from "node:test";
import assert from "node:assert/strict";
import {
  bandpassFilter,
  estimateBpmAndHrv,
  rejectRrArtifacts,
  baevskyStressIndex,
} from "../lib/signalProcessing.ts";

function makePulseSignal(bpm: number, fps: number, durationSec: number, noiseAmplitude = 0): number[] {
  const n = Math.round(fps * durationSec);
  const hz = bpm / 60;
  const signal: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    // A few harmonics to look more like a real PPG waveform than a pure sine.
    const value =
      Math.sin(2 * Math.PI * hz * t) +
      0.3 * Math.sin(2 * Math.PI * hz * 2 * t) +
      (noiseAmplitude > 0 ? (Math.random() * 2 - 1) * noiseAmplitude : 0);
    signal.push(value);
  }
  return signal;
}

test("bandpassFilter removes a strong out-of-band low-frequency drift", () => {
  const fps = 30;
  const n = 450; // 15s at 30fps
  const inBandHz = 1.2; // 72 BPM
  const driftHz = 0.05; // slow illumination drift, well below the 0.7Hz cutoff
  const signal = Array.from({ length: n }, (_, i) => {
    const t = i / fps;
    return Math.sin(2 * Math.PI * inBandHz * t) + 5 * Math.sin(2 * Math.PI * driftHz * t);
  });

  const filtered = bandpassFilter(signal, fps, 0.7, 4.0);

  // The filtered signal's amplitude should be dominated by the in-band
  // component (amplitude ~1), not the much larger out-of-band drift (~5).
  const maxAbs = Math.max(...filtered.map(Math.abs));
  assert.ok(maxAbs < 2.5, `expected the large low-frequency drift to be removed, max amplitude was ${maxAbs}`);
});

test("estimateBpmAndHrv recovers a known BPM from a clean synthetic pulse", () => {
  const fps = 30;
  const bpm = 72;
  const signal = makePulseSignal(bpm, fps, 15);
  const filtered = bandpassFilter(signal, fps);

  const result = estimateBpmAndHrv(filtered, fps);
  assert.ok(Math.abs(result.bpm - bpm) < 5, `expected ~${bpm} BPM, got ${result.bpm}`);
  assert.ok(result.beatsDetected >= 10, `expected several detected beats over 15s, got ${result.beatsDetected}`);
});

test("estimateBpmAndHrv still recovers a plausible BPM in the presence of moderate noise", () => {
  const fps = 30;
  const bpm = 65;
  const signal = makePulseSignal(bpm, fps, 15, 0.3);
  const filtered = bandpassFilter(signal, fps);

  const result = estimateBpmAndHrv(filtered, fps);
  assert.ok(Math.abs(result.bpm - bpm) < 8, `expected ~${bpm} BPM under noise, got ${result.bpm}`);
});

test("estimateBpmAndHrv reports HRV/stress as unavailable (not a fabricated number) when too few beats are detected", () => {
  const fps = 30;
  // A signal far too short to contain enough beats for a real HRV estimate.
  const flat = new Array(10).fill(0);
  const result = estimateBpmAndHrv(flat, fps);
  assert.equal(result.sdnn, null);
  assert.equal(result.rmssd, null);
  assert.equal(result.stressIndex, null);
});

test("estimateBpmAndHrv produces a real (non-zero, in-range) stress index for a clean pulse", () => {
  const fps = 30;
  const signal = makePulseSignal(72, fps, 15);
  const filtered = bandpassFilter(signal, fps);
  const result = estimateBpmAndHrv(filtered, fps);
  assert.ok(result.stressIndex !== null, "stress index should be computable for a clean 15s pulse");
  assert.ok(
    (result.stressIndex as number) >= 0 && (result.stressIndex as number) <= 100,
    `stress index should be within 0-100, got ${result.stressIndex}`
  );
  // A perfectly periodic synthetic pulse has near-zero true HRV, so its
  // histogram is tightly concentrated -> this should NOT read as maximally
  // relaxed (0). This is the regression guard for the "stuck at 0" bug.
  assert.ok(
    (result.stressIndex as number) > 0,
    `a tightly-periodic pulse should not read as 0 stress, got ${result.stressIndex}`
  );
});

test("rejectRrArtifacts drops beats far from the median but keeps genuine variation", () => {
  // 850ms baseline with real ±10ms jitter, plus one spurious short (450) and
  // one missed-beat long (1300) interval.
  const cleaned = rejectRrArtifacts([850, 860, 845, 450, 855, 1300, 848, 858]);
  assert.ok(!cleaned.includes(450), "spurious short interval should be rejected");
  assert.ok(!cleaned.includes(1300), "missed-beat long interval should be rejected");
  assert.ok(cleaned.includes(860) && cleaned.includes(845), "genuine ±jitter should be kept");
});

test("baevskyStressIndex rises as the RR distribution tightens (less variability = more stress)", () => {
  // Spread RR (high HRV, relaxed) vs tightly-clustered RR (low HRV, stressed).
  const relaxed = baevskyStressIndex([780, 900, 820, 880, 800, 920, 790, 870, 810]);
  const stressed = baevskyStressIndex([700, 704, 698, 702, 700, 703, 699, 701, 700]);
  assert.ok(
    stressed > relaxed,
    `tighter RR distribution should read as more stressed (relaxed=${relaxed}, stressed=${stressed})`
  );
  assert.ok(relaxed >= 0 && stressed <= 100, "stress index stays within 0-100");
});
