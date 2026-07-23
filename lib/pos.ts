// POS (Plane-Orthogonal-to-Skin) rPPG algorithm — Wang et al., "Algorithmic
// Principles of Remote PPG" (2016). Projects temporally-normalized RGB
// channel signals onto a plane orthogonal to the skin-tone vector, which
// cancels most illumination/motion artifacts shared across channels while
// preserving the subtle blood-volume-pulse component.
//
// Simplified for a fixed short clip: the original paper uses a sliding
// ~1.6s window with overlap-add for continuous/online signals. Since a
// HeartPulse scan is a single fixed-length (15s) clip processed as a batch
// afterward, we apply the same projection over the whole window at once —
// a common simplification for short-clip rPPG that avoids overlap-add
// bookkeeping without materially hurting accuracy at this length.

export interface RgbSample {
  t: number;
  r: number;
  g: number;
  b: number;
}

export function posSignalFromRgbSeries(samples: RgbSample[]): number[] {
  const n = samples.length;
  if (n === 0) return [];

  const rMean = mean(samples.map((s) => s.r));
  const gMean = mean(samples.map((s) => s.g));
  const bMean = mean(samples.map((s) => s.b));

  const s1 = new Array<number>(n);
  const s2 = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    // Temporal normalization per channel (divide by its own mean).
    const rn = rMean === 0 ? 0 : samples[i].r / rMean;
    const gn = gMean === 0 ? 0 : samples[i].g / gMean;
    const bn = bMean === 0 ? 0 : samples[i].b / bMean;

    s1[i] = gn - bn;
    s2[i] = -2 * rn + gn + bn;
  }

  const std1 = stdDev(s1);
  const std2 = stdDev(s2);
  const alpha = std2 === 0 ? 0 : std1 / std2;

  const h = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    h[i] = s1[i] + alpha * s2[i];
  }
  return h;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}
