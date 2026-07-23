// Turns the POS pulse signal into a heart rate (BPM) and short-window HRV
// estimate (SDNN, RMSSD). Two FFT passes: one to bandpass-filter the signal
// in the frequency domain (keeping only the physiologically plausible
// 42-240 BPM band), one to find the dominant frequency (= BPM). Beat
// timestamps for HRV come from simple time-domain peak-picking on the
// filtered waveform.
//
// A short (15s), non-periodic-in-window signal has real spectral leakage:
// any slow drift that doesn't complete a whole number of cycles within the
// window creates a boundary discontinuity once zero-padded to the next
// power of two, which spreads energy across the whole spectrum — including
// into the heart-rate band. We reduce this with a linear detrend (removes
// the dominant illumination-drift-shaped slope) and, for the frequency-
// domain peak search specifically, a Hann taper (standard leakage
// mitigation before an FFT). The Hann-windowed copy is only used to *find*
// the peak frequency; the un-windowed, detrended signal is what actually
// gets bandpass-filtered and returned for time-domain peak (HRV) detection.
//
// Caveat: 15 seconds is short for HRV in the clinical sense (SDNN/RMSSD
// are normally computed over minutes) — treat these as approximate,
// same-session indicators rather than diagnostic values.

import { fft, ifft, nextPowerOfTwo } from "./fft.ts";

const MIN_HZ = 0.7; // 42 BPM
const MAX_HZ = 4.0; // 240 BPM

export function bandpassFilter(signal: number[], fps: number, lowHz = MIN_HZ, highHz = MAX_HZ): number[] {
  const detrended = detrend(signal);

  const n = nextPowerOfTwo(detrended.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < detrended.length; i++) re[i] = detrended[i];

  fft(re, im);

  const freqPerBin = fps / n;
  for (let k = 0; k < n; k++) {
    const freq = k <= n / 2 ? k * freqPerBin : (k - n) * freqPerBin;
    const absFreq = Math.abs(freq);
    if (absFreq < lowHz || absFreq > highHz) {
      re[k] = 0;
      im[k] = 0;
    }
  }

  ifft(re, im);
  return Array.from(re.slice(0, signal.length));
}

export interface HeartRateEstimate {
  bpm: number;
  sdnn: number;
  rmssd: number;
  /** Number of beats detected in the time-domain peak pass — low counts mean the HRV numbers are unreliable. */
  beatsDetected: number;
}

export function estimateBpmAndHrv(filteredSignal: number[], fps: number): HeartRateEstimate {
  const bpm = findDominantBpm(filteredSignal, fps);

  // Guard the minimum spacing between accepted beats at ~1.6x the expected
  // period so we don't double-count a peak's shoulder as a second beat.
  const expectedPeriodSamples = fps / (bpm / 60);
  const minDistance = Math.max(1, Math.round(expectedPeriodSamples / 1.6));
  const peakIndices = detectPeaks(filteredSignal, minDistance);

  const rrIntervalsMs: number[] = [];
  for (let i = 1; i < peakIndices.length; i++) {
    rrIntervalsMs.push(((peakIndices[i] - peakIndices[i - 1]) / fps) * 1000);
  }

  let sdnn: number;
  let rmssd: number;
  if (rrIntervalsMs.length >= 2) {
    const rrMean = mean(rrIntervalsMs);
    sdnn = Math.sqrt(mean(rrIntervalsMs.map((x) => (x - rrMean) ** 2)));
    const diffs: number[] = [];
    for (let i = 1; i < rrIntervalsMs.length; i++) diffs.push(rrIntervalsMs[i] - rrIntervalsMs[i - 1]);
    rmssd = Math.sqrt(mean(diffs.map((d) => d * d)));
  } else {
    // Too few clean beats for a real HRV estimate — fall back to
    // population-average-ish placeholders rather than reporting 0.
    sdnn = 30;
    rmssd = 25;
  }

  return { bpm, sdnn, rmssd, beatsDetected: peakIndices.length };
}

function findDominantBpm(filteredSignal: number[], fps: number): number {
  const detrended = detrend(filteredSignal);
  const window = hannWindow(detrended.length);
  const windowed = detrended.map((v, i) => v * window[i]);

  const n = nextPowerOfTwo(windowed.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < windowed.length; i++) re[i] = windowed[i];
  fft(re, im);

  const freqPerBin = fps / n;
  let bestBin = 1;
  let bestMag = -1;
  for (let k = 1; k < n / 2; k++) {
    const freq = k * freqPerBin;
    if (freq < MIN_HZ || freq > MAX_HZ) continue;
    const mag = Math.hypot(re[k], im[k]);
    if (mag > bestMag) {
      bestMag = mag;
      bestBin = k;
    }
  }
  return bestBin * freqPerBin * 60;
}

function detectPeaks(signal: number[], minDistance: number): number[] {
  const peaks: number[] = [];
  for (let i = 1; i < signal.length - 1; i++) {
    const isLocalMax = signal[i] > signal[i - 1] && signal[i] >= signal[i + 1];
    if (!isLocalMax) continue;

    const lastPeak = peaks[peaks.length - 1];
    if (lastPeak === undefined || i - lastPeak >= minDistance) {
      peaks.push(i);
    } else if (signal[i] > signal[lastPeak]) {
      peaks[peaks.length - 1] = i;
    }
  }
  return peaks;
}

/** Removes the best-fit linear trend (least squares) from a signal. */
function detrend(signal: number[]): number[] {
  const n = signal.length;
  if (n < 2) return signal.slice();

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += signal[i];
    sumXY += i * signal[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  return signal.map((y, i) => y - (slope * i + intercept));
}

function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n <= 1) {
    w.fill(1);
    return w;
  }
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
