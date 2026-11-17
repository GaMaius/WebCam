// Iterative radix-2 Cooley-Tukey FFT/IFFT, in place, on parallel
// real/imaginary Float64Arrays. Length must be a power of two — callers
// zero-pad. No external dependency; this is the only DSP primitive the
// bandpass filter and BPM/HRV extraction need.

export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len / 2;
    const ang = (-2 * Math.PI) / len;
    const wReStep = Math.cos(ang);
    const wImStep = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWRe = 1;
      let curWIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * curWRe - im[i + j + half] * curWIm;
        const vIm = re[i + j + half] * curWIm + im[i + j + half] * curWRe;

        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;

        const nextWRe = curWRe * wReStep - curWIm * wImStep;
        const nextWIm = curWRe * wImStep + curWIm * wReStep;
        curWRe = nextWRe;
        curWIm = nextWIm;
      }
    }
  }
}

export function ifft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] = re[i] / n;
    im[i] = -im[i] / n;
  }
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
