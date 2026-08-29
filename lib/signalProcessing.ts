// Turns an rPPG pulse signal (TS-CAN or the POS fallback) into a heart rate
// (BPM) and short-window HRV
// estimate (SDNN, RMSSD). Two FFT passes: one to bandpass-filter the signal
// in the frequency domain (keeping only the physiologically plausible
// 42-240 BPM band), one to find the dominant frequency (= BPM). Beat
// timestamps for HRV come from simple time-domain peak-picking on the
// filtered waveform.
//
// A short (30s and under), non-periodic-in-window signal has real spectral leakage:
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
// Caveat: even a 30s window is short for HRV in the clinical sense (SDNN and
// frequency-domain metrics are normally computed over minutes) — treat these
// as approximate, same-session indicators rather than diagnostic values.
// RMSSD/SD1 are the metrics that survive short windows, so the stress index
// is built on those (plus a heart-rate-elevation term), not on a histogram
// statistic like the Baevsky index which is too fragile on noisy webcam RR.

import { fft, ifft, nextPowerOfTwo } from "./fft.ts";

const MIN_HZ = 0.7; // 42 BPM
const MAX_HZ = 4.0; // 240 BPM

/**
 * Resamples an irregularly-timed signal onto a uniform grid.
 *
 * Everything downstream — the FFT bandpass, the dominant-frequency search, the
 * RR intervals — assumes samples are evenly spaced in time. A webcam does not
 * deliver that: browsers drop frames under load, and a rAF-driven capture reads
 * whatever frame happens to be current. Passing an *average* fps papers over the
 * mean but leaves the jitter, which smears the pulse peak across neighbouring
 * bins — exactly where a few BPM of error comes from.
 *
 * The upstream demo assumes a fixed 30 Hz and never measures it, so this is one
 * place we deliberately do more than the reference rather than less.
 *
 * `timesMs` must be non-decreasing and the same length as `values`. Linear
 * interpolation is enough here: we resample to a rate at or above the capture
 * rate, so this interpolates between neighbours rather than decimating (which
 * would need an anti-alias filter first).
 */
export function resampleUniform(
  values: number[],
  timesMs: number[],
  targetFps: number
): number[] {
  if (values.length < 2 || values.length !== timesMs.length) return values.slice();

  const start = timesMs[0];
  const end = timesMs[timesMs.length - 1];
  const durationSec = (end - start) / 1000;
  if (!(durationSec > 0)) return values.slice();

  const count = Math.floor(durationSec * targetFps) + 1;
  const out: number[] = new Array(count);
  let cursor = 0;

  for (let i = 0; i < count; i++) {
    const t = start + (i / targetFps) * 1000;
    while (cursor < timesMs.length - 2 && timesMs[cursor + 1] < t) cursor++;
    const t0 = timesMs[cursor];
    const t1 = timesMs[cursor + 1];
    const span = t1 - t0;
    // Coincident timestamps would divide by zero; hold the earlier sample.
    const alpha = span > 0 ? Math.min(1, Math.max(0, (t - t0) / span)) : 0;
    out[i] = values[cursor] + (values[cursor + 1] - values[cursor]) * alpha;
  }
  return out;
}

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
  /** Poincaré SD1 (= RMSSD / √2), the standard short-term parasympathetic index. */
  sd1: number | null;
  /** 0-100 stress index (composite of RMSSD/SD1 + heart-rate elevation,
   * higher = more sympathetic/stressed). null when the signal is too weak
   * (too few clean beats or low SNR) to report honestly — never a fabricated 0. */
  stressIndex: number | null;
  /** Spectral signal-to-noise ratio of the pulse peak (dB) — the primary
   * signal-quality measure, from the FFT rather than fragile peak detection. */
  snrDb: number;
  /** Number of raw beats detected in the time-domain peak pass. */
  beatsDetected: number;
  /** Number of RR intervals surviving artifact rejection. */
  cleanBeats: number;
}

// Physiologically-implausible RR intervals (180+ BPM or under 40 BPM) are
// almost always a mis-detected peak rather than a real beat-to-beat gap.
const MIN_RR_MS = 333; // 180 BPM
const MAX_RR_MS = 1500; // 40 BPM

// Malik criterion: reject a beat if it differs from the previous accepted
// interval by more than 20% — the most widely used relative artifact filter.
const MALIK_TOLERANCE = 0.2;
// Median-relative gate (Kubios "medium" preset, ~0.25) as a first pass.
const RR_MEDIAN_TOLERANCE = 0.25;

// Need at least this many clean (artifact-rejected) intervals before we're
// willing to report an HRV/stress number — below this it's noise, so we
// report "insufficient signal" rather than a spurious 0. SNR is NOT a hard
// gate (it's uncalibrated across devices and would risk nulling every real
// reading); it feeds the confidence score instead, so a weak-but-present
// signal still yields a value shown at low confidence.
const MIN_CLEAN_RR = 6;

// Population resting-HR reference for the heart-rate-elevation term. A real
// per-user baseline (localStorage trend) would be better, but this keeps the
// term meaningful on a first measurement.
const RESTING_HR_REF = 60;
const MAX_HR_REF = 100;
// RMSSD reference band (Shaffer & Ginsberg 2017 adult norms, ms): high vagal
// tone (relaxed) ~70, low vagal tone (stressed) ~15.
const RMSSD_RELAXED = 70;
const RMSSD_STRESSED = 15;

export function estimateBpmAndHrv(filteredSignal: number[], fps: number, restingHr = RESTING_HR_REF): HeartRateEstimate {
  const { bpm, snrDb } = analyzeSpectrum(filteredSignal, fps);

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
      sd1: null,
      stressIndex: null,
      snrDb,
      beatsDetected: peakPositions.length,
      cleanBeats: rr.length,
    };
  }

  const rrMean = mean(rr);
  const sdnn = Math.sqrt(mean(rr.map((x) => (x - rrMean) ** 2)));
  const diffs: number[] = [];
  for (let i = 1; i < rr.length; i++) diffs.push(rr[i] - rr[i - 1]);
  const rmssd = Math.sqrt(mean(diffs.map((d) => d * d)));
  const sd1 = rmssd / Math.SQRT2;

  const stressIndex = compositeStress(rmssd, bpm, restingHr);

  return {
    bpm,
    sdnn,
    rmssd,
    sd1,
    stressIndex,
    snrDb,
    beatsDetected: peakPositions.length,
    cleanBeats: rr.length,
  };
}

/** Two-stage RR artifact rejection: a robust median-relative gate (removes
 * gross outliers) followed by the Malik ±20% successive-difference filter
 * (removes ectopic/split/merged beats that survive the first pass). Genuine
 * beat-to-beat variation — a few percent of the mean RR — is preserved. */
export function rejectRrArtifacts(rrMs: number[]): number[] {
  if (rrMs.length < 2) return rrMs.slice();
  const med = median(rrMs);
  if (med <= 0) return rrMs.slice();

  const lo = med * (1 - RR_MEDIAN_TOLERANCE);
  const hi = med * (1 + RR_MEDIAN_TOLERANCE);
  const medianFiltered = rrMs.filter((x) => x >= lo && x <= hi);
  if (medianFiltered.length < 2) return medianFiltered;

  const out: number[] = [medianFiltered[0]];
  for (let i = 1; i < medianFiltered.length; i++) {
    const prev = out[out.length - 1];
    if (Math.abs(medianFiltered[i] - prev) <= MALIK_TOLERANCE * prev) {
      out.push(medianFiltered[i]);
    }
  }
  return out;
}

/**
 * Composite stress index (0-100), grounded in short-window HRV literature:
 *   - Component B (weight 0.65): RMSSD relative to adult norms — lower
 *     RMSSD = lower parasympathetic tone = more stress. RMSSD is the metric
 *     that stays reliable on short windows.
 *   - Component A (weight 0.35): heart-rate elevation relative to a resting
 *     reference — an elevated HR is a low-noise stress signal.
 * The blend avoids depending on any single fragile statistic and won't pin
 * to 0 the way the old Baevsky histogram did.
 */
export function compositeStress(rmssd: number, bpm: number, restingHr = RESTING_HR_REF): number {
  const hrElevation = clamp01((bpm - restingHr) / (MAX_HR_REF - restingHr));
  const lowVagal = clamp01((RMSSD_RELAXED - rmssd) / (RMSSD_RELAXED - RMSSD_STRESSED));
  const score = 0.35 * hrElevation + 0.65 * lowVagal;
  // Floor a *valid* reading at 5: a genuinely very-relaxed person still gets a
  // real "low stress" number rather than a bare 0, which reads as "no data".
  return Math.max(5, Math.round(100 * clamp01(score)));
}

/** Single-FFT spectral analysis: dominant heart-rate frequency (BPM) plus a
 * de Haan & Jeanne style SNR — signal power in the HR peak (±6 BPM) and its
 * first harmonic (±12 BPM) vs. the rest of the 0.7-4Hz band. A sharp,
 * dominant peak (high SNR) means a trustworthy pulse; a smeared spectrum
 * means noise. This replaces fragile peak-counting as the quality measure. */
export function analyzeSpectrum(signal: number[], fps: number): { bpm: number; snrDb: number } {
  const detrended = detrend(signal);
  const window = hannWindow(detrended.length);
  const windowed = detrended.map((v, i) => v * window[i]);

  const n = nextPowerOfTwo(windowed.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < windowed.length; i++) re[i] = windowed[i];
  fft(re, im);

  const freqPerBin = fps / n;
  const half = Math.floor(n / 2);
  const mag = new Float64Array(half);
  let bestBin = 1;
  let bestMag = -1;
  for (let k = 1; k < half; k++) {
    const freq = k * freqPerBin;
    mag[k] = Math.hypot(re[k], im[k]);
    if (freq >= MIN_HZ && freq <= MAX_HZ && mag[k] > bestMag) {
      bestMag = mag[k];
      bestBin = k;
    }
  }
  const bpm = bestBin * freqPerBin * 60;
  const hrHz = bpm / 60;

  let pSignal = 0;
  let pNoise = 0;
  for (let k = 1; k < half; k++) {
    const freq = k * freqPerBin;
    if (freq < MIN_HZ || freq > MAX_HZ) continue;
    const power = mag[k] * mag[k];
    const nearFundamental = Math.abs(freq - hrHz) <= 0.1; // ±6 BPM
    const nearHarmonic = 2 * hrHz <= MAX_HZ && Math.abs(freq - 2 * hrHz) <= 0.2; // ±12 BPM
    if (nearFundamental || nearHarmonic) pSignal += power;
    else pNoise += power;
  }
  const snrDb = pNoise > 0 ? 10 * Math.log10(pSignal / pNoise) : pSignal > 0 ? 20 : -20;
  return { bpm, snrDb };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
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
  // frames (e.g. ~33ms at the 30Hz analysis grid), and that
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
