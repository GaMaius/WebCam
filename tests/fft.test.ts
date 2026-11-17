import test from "node:test";
import assert from "node:assert/strict";
import { fft, ifft, nextPowerOfTwo } from "../lib/fft.ts";

test("nextPowerOfTwo rounds up to the nearest power of two", () => {
  assert.equal(nextPowerOfTwo(1), 1);
  assert.equal(nextPowerOfTwo(2), 2);
  assert.equal(nextPowerOfTwo(5), 8);
  assert.equal(nextPowerOfTwo(17), 32);
  assert.equal(nextPowerOfTwo(64), 64);
});

test("ifft(fft(x)) reconstructs the original signal", () => {
  const n = 64;
  const original = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 3 * i) / n) + 0.5);
  const re = Float64Array.from(original);
  const im = new Float64Array(n);

  fft(re, im);
  ifft(re, im);

  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] - original[i]) < 1e-9, `sample ${i} did not round-trip`);
    assert.ok(Math.abs(im[i]) < 1e-9, `sample ${i} has residual imaginary part`);
  }
});

test("fft identifies the frequency of a pure sine wave", () => {
  const n = 256;
  const fps = 32; // samples per second
  const signalHz = 2; // known frequency to recover
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = Math.sin((2 * Math.PI * signalHz * i) / fps);
  }

  fft(re, im);

  const freqPerBin = fps / n;
  let bestBin = 0;
  let bestMag = -1;
  for (let k = 1; k < n / 2; k++) {
    const mag = Math.hypot(re[k], im[k]);
    if (mag > bestMag) {
      bestMag = mag;
      bestBin = k;
    }
  }
  const detectedHz = bestBin * freqPerBin;
  assert.ok(Math.abs(detectedHz - signalHz) < freqPerBin, `expected ~${signalHz}Hz, got ${detectedHz}Hz`);
});
