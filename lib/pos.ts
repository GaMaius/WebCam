// POS (Plane-Orthogonal-to-Skin) rPPG algorithm — Wang, den Brinker, Stuijk
// & de Haan, "Algorithmic Principles of Remote PPG" (IEEE TBME, 2017).
//
// This is a direct port of `POS_WANG` from ubicomplab/rPPG-Toolbox
// (unsupervised_methods/methods/POS_WANG.py), not a from-scratch
// reimplementation of the paper: a 1.6s window slides one sample at a time
// across the RGB series, each window is temporally normalized and projected
// onto the two-channel plane orthogonal to skin tone, scaled by
// alpha = std(S1)/std(S2), mean-centered, and overlap-added into the output
// — rather than normalizing once over the whole clip. This matters because
// it makes the projection robust to slow within-clip drift (illumination
// changes, slight ROI shift): each window is only ever compared against its
// own local statistics, so drift over the full clip can't skew it the way a
// single global window's mean/std would be skewed.
//
// Deliberately NOT ported (a note for anyone comparing against the source):
// the toolbox follows this projection with a Tarvainen-style smoothness-
// priors detrend (a regularized-least-squares matrix inversion) and a
// Butterworth bandpass applied via filtfilt. Porting the exact detrend
// requires solving a dense linear system per clip; this codebase uses a
// simpler linear detrend + FFT-based bandpass instead (see
// signalProcessing.ts) — same goal (remove drift, isolate the heart-rate
// band), different, dependency-free means, verified separately against
// synthetic ground-truth signals.

export interface RgbSample {
  t: number;
  r: number;
  g: number;
  b: number;
}

const WINDOW_SECONDS = 1.6;

export function posSignalFromRgbSeries(samples: RgbSample[], fps: number): number[] {
  const N = samples.length;
  if (N === 0) return [];

  const windowLen = Math.ceil(WINDOW_SECONDS * fps);
  const H = new Array<number>(N).fill(0);

  for (let n = 0; n < N; n++) {
    const m = n - windowLen;
    if (m < 0) continue;

    // Window is samples[m, n) — i.e. it does NOT include sample n itself,
    // matching the reference's Python slice semantics exactly.
    let rMean = 0;
    let gMean = 0;
    let bMean = 0;
    for (let i = m; i < n; i++) {
      rMean += samples[i].r;
      gMean += samples[i].g;
      bMean += samples[i].b;
    }
    rMean /= windowLen;
    gMean /= windowLen;
    bMean /= windowLen;

    const s1 = new Array<number>(windowLen);
    const s2 = new Array<number>(windowLen);
    for (let i = 0; i < windowLen; i++) {
      const s = samples[m + i];
      const rn = rMean === 0 ? 0 : s.r / rMean;
      const gn = gMean === 0 ? 0 : s.g / gMean;
      const bn = bMean === 0 ? 0 : s.b / bMean;
      s1[i] = gn - bn;
      s2[i] = -2 * rn + gn + bn;
    }

    const std1 = stdDev(s1);
    const std2 = stdDev(s2);
    const alpha = std2 === 0 ? 0 : std1 / std2;

    const h = new Array<number>(windowLen);
    for (let i = 0; i < windowLen; i++) h[i] = s1[i] + alpha * s2[i];

    const meanH = mean(h);
    for (let i = 0; i < windowLen; i++) {
      H[m + i] += h[i] - meanH;
    }
  }

  return H;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}
