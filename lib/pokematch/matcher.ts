// PokéMatch core: loads the ONNX image encoder + precomputed pokemon gallery,
// embeds a cropped face, and ranks pokemon by z-score-debiased cosine
// similarity (see ml/pokematch — z = (cos - mu_p) / sd_p removes the
// "close to every face" popularity bias). Assets are produced by the Colab
// notebook and placed under /public (see README).

import * as ort from "onnxruntime-web";

const ORT_VERSION = "1.27.0";
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

const ENCODER_URL = "/models/pokemon_encoder.onnx";
const GALLERY_BIN = "/pokemon/gallery.bin";
const GALLERY_JSON = "/pokemon/gallery.json";
const POKEDEX_JSON = "/pokemon/pokedex.json";

/** Base URL for representative images: `${base}/${slug}.webp`.
 * Default: bundled under /public/pokemon/img. Set to a B2 public URL to host
 * them off-repo instead. */
export const POKEMATCH_IMG_BASE = "/pokemon/img";
export function pokemonImageUrl(slug: string): string {
  return `${POKEMATCH_IMG_BASE}/${slug}.webp`;
}

/** Encoder input side (open_clip preprocess: resize+center-crop 256, [0,1] RGB). */
export const POKEMATCH_IMG_SIZE = 256;

export interface PokedexEntry {
  slug: string;
  nameEn: string;
  nameKo: string | null;
  dex: number | null;
  typesEn: string[];
  typesKo: string[];
  color?: string | null;
  shape?: string | null;
}

interface GalleryMeta {
  species: string[];
  dim: number;
  count: number;
  scale: number;
  mu: number[];
  sd: number[];
}

export interface Gallery {
  species: string[];
  dim: number;
  vecs: Float32Array; // [count * dim], dequantized + per-vector L2-normalized
  mu: Float32Array;
  sd: Float32Array;
}

export interface PokematchMatch {
  slug: string;
  entry: PokedexEntry | null;
  z: number;
  percent: number;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let galleryPromise: Promise<Gallery> | null = null;
let pokedexPromise: Promise<Record<string, PokedexEntry>> | null = null;

export function loadEncoder(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(ENCODER_URL, { executionProviders: ["wasm"] });
    sessionPromise.catch(() => (sessionPromise = null));
  }
  return sessionPromise;
}

export function loadGallery(): Promise<Gallery> {
  if (!galleryPromise) {
    galleryPromise = (async () => {
      const [meta, binBuf] = await Promise.all([
        fetch(GALLERY_JSON).then((r) => r.json() as Promise<GalleryMeta>),
        fetch(GALLERY_BIN).then((r) => r.arrayBuffer()),
      ]);
      const { species, dim, scale, mu, sd } = meta;
      const q = new Int8Array(binBuf);
      const count = species.length;
      const vecs = new Float32Array(count * dim);
      for (let s = 0; s < count; s++) {
        let norm = 0;
        for (let d = 0; d < dim; d++) {
          const v = q[s * dim + d] / scale;
          vecs[s * dim + d] = v;
          norm += v * v;
        }
        norm = Math.sqrt(norm) || 1;
        for (let d = 0; d < dim; d++) vecs[s * dim + d] /= norm; // renormalize
      }
      return { species, dim, vecs, mu: Float32Array.from(mu), sd: Float32Array.from(sd) };
    })();
    galleryPromise.catch(() => (galleryPromise = null));
  }
  return galleryPromise;
}

export function loadPokedex(): Promise<Record<string, PokedexEntry>> {
  if (!pokedexPromise) {
    pokedexPromise = fetch(POKEDEX_JSON).then((r) => r.json());
    pokedexPromise.catch(() => (pokedexPromise = null));
  }
  return pokedexPromise;
}

/**
 * Embeds a 256x256 face crop (drawn onto `canvas`) into a normalized vector.
 * Preprocessing must match the gallery: RGB, pixel/255 in [0,1], no mean/std,
 * channel-first NCHW.
 */
export async function embedFace(
  session: ort.InferenceSession,
  canvas: HTMLCanvasElement
): Promise<Float32Array> {
  const size = POKEMATCH_IMG_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  const { data } = ctx.getImageData(0, 0, size, size);
  const plane = size * size;
  const chw = new Float32Array(3 * plane);
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    chw[p] = data[i] / 255; // R
    chw[plane + p] = data[i + 1] / 255; // G
    chw[2 * plane + p] = data[i + 2] / 255; // B
  }
  const tensor = new ort.Tensor("float32", chw, [1, 3, size, size]);
  const inputName = session.inputNames[0];
  const outName = session.outputNames[0];
  const results = await session.run({ [inputName]: tensor });
  const raw = results[outName].data as Float32Array;
  // L2-normalize (encoder already normalizes, but be safe).
  let norm = 0;
  for (let i = 0; i < raw.length; i++) norm += raw[i] * raw[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] / norm;
  return out;
}

/** Cosmetic mapping of z-score → "닮은 정도 %" (monotonic; ranking unaffected). */
export function zToPercent(z: number): number {
  return Math.round(Math.max(30, Math.min(99, 40 + 13 * z)));
}

/** Ranks the gallery by z-scored similarity and returns the top K matches. */
export function matchTopK(
  embedding: Float32Array,
  gallery: Gallery,
  pokedex: Record<string, PokedexEntry>,
  k = 5
): PokematchMatch[] {
  const { species, dim, vecs, mu, sd } = gallery;
  const scored: { i: number; z: number }[] = new Array(species.length);
  for (let s = 0; s < species.length; s++) {
    let dot = 0;
    const off = s * dim;
    for (let d = 0; d < dim; d++) dot += vecs[off + d] * embedding[d];
    scored[s] = { i: s, z: (dot - mu[s]) / (sd[s] || 1e-6) };
  }
  scored.sort((a, b) => b.z - a.z);
  return scored.slice(0, k).map(({ i, z }) => {
    const slug = species[i];
    return { slug, entry: pokedex[slug] ?? null, z, percent: zToPercent(z) };
  });
}
