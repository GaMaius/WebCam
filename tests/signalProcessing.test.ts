import test from "node:test";
import assert from "node:assert/strict";
import { bandpassFilter, estimateBpmAndHrv } from "../lib/signalProcessing.ts";

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

test("estimateBpmAndHrv reports HRV as unavailable (not a fabricated number) when too few beats are detected", () => {
  const fps = 30;
  // A signal far too short to contain enough beats for a real HRV estimate.
  const flat = new Array(10).fill(0);
  const result = estimateBpmAndHrv(flat, fps);
  assert.equal(result.sdnn, null);
  assert.equal(result.rmssd, null);
});
