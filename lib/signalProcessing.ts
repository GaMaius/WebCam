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
  /** null when too few clean beats were detected for a real HRV estimate — never a fabricated number. */
  sdnn: number | null;
  rmssd: number | null;
  /** 0-100 stress index (Baevsky-based, higher = more sympathetic/stressed).
   * null under the same too-few-beats condition as sdnn/rmssd. */
  stressIndex: number | null;
  /** Number of raw beats detected in the time-domain peak pass. */
  beatsDetected: number;
  /** Number of RR intervals surviving artifact rejection — the HRV/stress
   * numbers are only as trustworthy as this count. */
  cleanBeats: number;
}

// Physiologically-implausible RR intervals (180+ BPM or under 40 BPM) are
// almost always a mis-detected peak rather than a real beat-to-beat gap. A
// single such outlier dominates RMSSD (it's a diff-of-diffs), so we drop
// these before computing HRV rather than let one bad peak invalidate the
// whole reading.
const MIN_RR_MS = 333; // 180 BPM
const MAX_RR_MS = 1500; // 40 BPM

// Relative artifact tolerance: real beat-to-beat variation at rest is only a
// few percent of the mean RR, whereas a missed/extra/spurious peak lands far
// off the median. Intervals deviating from the (robust) median RR by more
// than this fraction are treated as artifacts and dropped. This is what was
// missing before: the absolute 333-1500ms window can't catch an alternating
// "split beat / merged beat" pattern that stays in range but wrecks RMSSD.
const RR_MEDIAN_TOLERANCE = 0.25;

// Need at least this many clean intervals before we're willing to report any
// HRV/stress number at all — below this it's noise, not a measurement.
const MIN_CLEAN_RR = 5;

export function estimateBpmAndHrv(filteredSignal: number[], fps: number): HeartRateEstimate {
  const bpm = findDominantBpm(filteredSignal, fps);

  // Guard the minimum spacing between accepted beats at ~1.6x the expected
  // period so we don't double-count a peak's shoulder as a second beat.
  const expectedPeriodSamples = fps / (bpm / 60);
  const minDistance = Math.max(1, Math.round(expectedPeriodSamples / 1.6));
  const peakPositions = detectPeaks(filteredSignal, minDistance);

  const rawRr: number[] = [];
  for (let i = 1; i < peakPositions.length; i++) {
    const rr = ((peakPositions[i] - peakPositions[i - 1]) / fps) * 1000;
    if (rr >= MIN_RR_MS && rr <= MAX_RR_MS) rawRr.push(rr);
  }

  const rr = rejectRrArtifacts(rawRr);

  if (rr.length < MIN_CLEAN_RR) {
    // Too few clean beats for a real HRV estimate — report as unavailable
    // rather than substituting a made-up number.
    return {
      bpm,
      sdnn: null,
      rmssd: null,
      stressIndex: null,
      beatsDetected: peakPositions.length,
      cleanBeats: rr.length,
    };
  }

  const rrMean = mean(rr);
  const sdnn = Math.sqrt(mean(rr.map((x) => (x - rrMean) ** 2)));
  const diffs: number[] = [];
  for (let i = 1; i < rr.length; i++) diffs.push(rr[i] - rr[i - 1]);
  const rmssd = Math.sqrt(mean(diffs.map((d) => d * d)));

  const stressIndex = baevskyStressIndex(rr);

  return {
    bpm,
    sdnn,
    rmssd,
    stressIndex,
    beatsDetected: peakPositions.length,
    cleanBeats: rr.length,
  };
}

/** Drops RR intervals that deviate from the median by more than
 * RR_MEDIAN_TOLERANCE — a robust artifact filter (missed/extra/spurious
 * beats) that leaves genuine beat-to-beat variation intact. */
export function rejectRrArtifacts(rrMs: number[]): number[] {
  if (rrMs.length < 2) return rrMs.slice();
  const med = median(rrMs);
  if (med <= 0) return rrMs.slice();
  const lo = med * (1 - RR_MEDIAN_TOLERANCE);
  const hi = med * (1 + RR_MEDIAN_TOLERANCE);
  return rrMs.filter((x) => x >= lo && x <= hi);
}

// --- Baevsky Stress Index -------------------------------------------------
// A recognized way to quantify sympathetic activation from the distribution
// of RR intervals (Baevsky et al.): SI = AMo / (2 * Mo * MxDMn), where the
// RR intervals are histogrammed into 50ms bins.
//   Mo (mode)     = most-frequent RR bin center, in seconds
//   AMo           = % of intervals in the modal bin
//   MxDMn         = (max RR - min RR), in seconds
// A tighter, more concentrated distribution (high AMo, small MxDMn) means
// the heart is "locked" to one rate — sympathetic dominance / stress — and
// yields a high SI. The raw SI is then squashed onto 0-100 with a log map
// whose anchors are calibrated (see tests/signalProcessing.test.ts) for this
// short-window webcam pipeline rather than clinical 5-minute ECG norms.
const SI_BIN_MS = 50;
// Anchors calibrated empirically against this pipeline's own output (15s
// window, ~15-30fps, 50ms bins) — a short-window webcam SI runs an order of
// magnitude higher than clinical 5-minute ECG norms, so these are tuned so a
// genuinely relaxed reading lands ~25-30 and a tightly-locked (stressed) one
// lands ~85-90, rather than blindly reusing clinical SI bands.
const SI_LOG_LOW = Math.log(50); // SI at/below this -> ~0 (very relaxed)
const SI_LOG_HIGH = Math.log(700); // SI at/above this -> ~100 (highly stressed)

export function baevskyStressIndex(rrMs: number[]): number {
  const n = rrMs.length;
  const bins = new Map<number, number>();
  for (const rr of rrMs) {
    const bin = Math.floor(rr / SI_BIN_MS);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  let modeBin = 0;
  let modeCount = 0;
  for (const [bin, count] of bins) {
    if (count > modeCount) {
      modeCount = count;
      modeBin = bin;
    }
  }
  const moSec = ((modeBin + 0.5) * SI_BIN_MS) / 1000;
  const aMo = (modeCount / n) * 100;
  const rangeMs = Math.max(...rrMs) - Math.min(...rrMs);
  // Floor the range at half a bin so an ultra-concentrated (near-zero-range)
  // reading can't send SI to infinity.
  const mxdmnSec = Math.max(rangeMs, SI_BIN_MS / 2) / 1000;
  const si = aMo / (2 * moSec * mxdmnSec);

  const norm = ((Math.log(si) - SI_LOG_LOW) / (SI_LOG_HIGH - SI_LOG_LOW)) * 100;
  return Math.max(0, Math.min(100, Math.round(norm)));
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
  // Refine each integer sample index to a sub-sample position via parabolic
  // interpolation. Without this, RR intervals are quantized to whole video
  // frames (e.g. ~67ms at the DeepPhys path's reduced ~15fps), and that
  // jitter alone is enough to inflate RMSSD past any reasonable stress-scale
  // denominator — this is what was collapsing the stress index to 0 on
  // otherwise-good captures.
  return peaks.map((i) => refinePeakPosition(signal, i));
}

function refinePeakPosition(signal: number[], i: number): number {
  const yLeft = signal[i - 1];
  const yCenter = signal[i];
  const yRight = signal[i + 1];
  const denom = yLeft - 2 * yCenter + yRight;
  if (denom === 0) return i;
  const delta = (0.5 * (yLeft - yRight)) / denom;
  // Keep the refinement within the immediate neighborhood of the detected
  // sample — a large delta means the parabola fit is degenerate, not that
  // the true peak is a full sample away.
  return i + Math.max(-0.5, Math.min(0.5, delta));
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

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
