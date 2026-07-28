// PokéMatch core: loads the ONNX image encoder + precomputed pokemon gallery,
// embeds a cropped face, and ranks pokemon by z-score-debiased cosine
// similarity (see ml/pokematch — z = (cos - mu_p) / sd_p removes the
// "close to every face" popularity bias). Assets are produced by the Colab
// notebook and placed under /public (see README).

import * as ort from "onnxruntime-web";
import {
  ENCODER_URL,
  GALLERY_BIN,
  GALLERY_JSON,
  POKEDEX_JSON,
  POKEMATCH_IMG_SIZE,
} from "./assets";

// Re-export for existing importers (page.tsx etc.).
export { POKEMATCH_IMG_BASE, POKEMATCH_IMG_SIZE, pokemonImageUrl } from "./assets";

const ORT_VERSION = "1.27.0";
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

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

export interface FaceSubAnalysis {
  faceShapeName: string;
  eyeImpression: string;
  colorPalette: string;
  vibeName: string;
  scores: {
    geometrySync: number;
    featureSync: number;
    colorSync: number;
    vibeSync: number;
  };
}

export interface PokematchMatch {
  slug: string;
  entry: PokedexEntry | null;
  z: number;
  percent: number;
  subAnalysis?: FaceSubAnalysis;
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

/** Cosmetic mapping of a per-face-standardized z (how far above this face's
 * own mean the match sits) → "닮은 정도 %". Standardizing per face makes the
 * shown similarity independent of capture magnitude, while relative decay from
 * the top match ensures clear distinction between top 1~5 ranks. */
export function zToPercent(standardizedZ: number, topStandardizedZ?: number): number {
  const szTop = topStandardizedZ ?? standardizedZ;
  const p1 = Math.max(92, Math.min(96, Math.round(88 + 2.5 * (szTop - 2.5))));
  const drop = (szTop - standardizedZ) * 28.0;
  return Math.max(55, Math.min(p1, Math.round(p1 - drop)));
}

export interface DebugRankRow {
  slug: string;
  cos: number;
  z: number;
  mu: number;
  sd: number;
}

/** Full ranking detail (cosine, z, and the per-species μ/σ) for diagnosing
 * why a given face ranks the way it does — surfaced only under ?debug. */
export function debugRank(embedding: Float32Array, gallery: Gallery, k = 20): { byZ: DebugRankRow[]; byCos: DebugRankRow[] } {
  const { species, dim, vecs, mu, sd } = gallery;
  const rows: DebugRankRow[] = species.map((slug, s) => {
    let dot = 0;
    const off = s * dim;
    for (let d = 0; d < dim; d++) dot += vecs[off + d] * embedding[d];
    return { slug, cos: dot, z: (dot - mu[s]) / (sd[s] || 1e-6), mu: mu[s], sd: sd[s] };
  });
  const byZ = [...rows].sort((a, b) => b.z - a.z).slice(0, k);
  const byCos = [...rows].sort((a, b) => b.cos - a.cos).slice(0, k);
  return { byZ, byCos };
}

const OVERRIDE_BALL_SLUGS = new Set([
  "jigglypuff",
  "igglybuff",
  "wigglytuff",
  "clefairy",
  "cleffa",
  "clefable",
  "marill",
  "azumarill",
  "chansey",
  "blissey",
  "happiny",
  "spheal",
  "voltorb",
  "electrode",
  "gulpin",
  "swalot",
  "solosis",
  "duosion",
]);

const CHAR_SHAPE_BOOST: Record<string, number> = {
  humanoid: 0.22,
  upright: 0.16,
  heads: 0.08,
  arms: 0.06,
  legs: 0.04,
  blob: -0.05,
  ball: -0.12,
  quadruped: -0.10,
  fish: -0.25,
  "bug-wings": -0.20,
  tentacles: -0.20,
  armor: -0.18,
  squiggle: -0.25,
};

function computeSubAnalysis(
  entry: PokedexEntry | null,
  percent: number,
  faceAspect: number
): FaceSubAnalysis {
  let faceShapeName = "계란형 (Balanced Oval)";
  if (faceAspect > 1.22) faceShapeName = "슬림 계란형 (Slim Oblong)";
  else if (faceAspect > 1.14) faceShapeName = "계란형 (Classic Oval)";
  else if (faceAspect < 1.05) faceShapeName = "소프트 둥근형 (Soft Round)";
  else faceShapeName = "내추럴 계란형 (Natural Oval)";

  const eyeImpression = faceAspect > 1.18 ? "샤프함 / 지적임" : "부드러움 / 뚜렷함";
  const colorPalette = entry?.color ? `${entry.color.toUpperCase()} & 딥 톤` : "다크 & 쿨톤";
  const vibeName = percent > 90 ? "독보적인 카리스마 & 아우라" : "차분하고 명석함";

  let shapeBonus = 0;
  if (faceAspect > 1.18 && (entry?.shape === "humanoid" || entry?.shape === "upright")) {
    shapeBonus = 6;
  } else if (faceAspect < 1.05 && (entry?.shape === "ball" || entry?.shape === "blob")) {
    shapeBonus = 6;
  }
  const geometrySync = Math.min(99, Math.max(82, Math.round(percent * 0.92 + shapeBonus)));
  const featureSync = Math.min(99, Math.max(80, Math.round(percent * 0.96)));
  const colorSync = Math.min(99, Math.max(84, Math.round(percent * 0.88 + 8)));
  const vibeSync = Math.min(99, Math.max(85, Math.round(percent * 0.94 + 4)));

  return {
    faceShapeName,
    eyeImpression,
    colorPalette,
    vibeName,
    scores: {
      geometrySync,
      featureSync,
      colorSync,
      vibeSync,
    },
  };
}

const NON_HUMAN_EXCLUDE_SHAPES = new Set([
  "fish",
  "bug-wings",
  "tentacles",
  "armor",
  "squiggle",
  "ball",
  "blob",
  "quadruped",
]);

const HUB_EXCLUDE_SLUGS = new Set([
  "jigglypuff",
  "igglybuff",
  "wigglytuff",
  "electrode",
  "voltorb",
  "chi_yu",
  "goldeen",
  "seaking",
]);

/** Ranks the gallery by z-scored similarity and returns the top K matches. */
export function matchTopK(
  embedding: Float32Array,
  gallery: Gallery,
  pokedex: Record<string, PokedexEntry>,
  k = 5,
  options?: { faceAspect?: number }
): PokematchMatch[] {
  const { species, dim, vecs, mu, sd } = gallery;
  const n = species.length;
  const scored: { i: number; z: number }[] = new Array(n);
  const faceAspect = options?.faceAspect ?? 1.15;
  let sum = 0;

  for (let s = 0; s < n; s++) {
    let dot = 0;
    const off = s * dim;
    for (let d = 0; d < dim; d++) dot += vecs[off + d] * embedding[d];
    
    // Variance floor prevents species with tiny standard deviation from spiking unnaturally
    const sdEff = Math.max(sd[s] || 1e-6, 0.038);
    const rawZ = (dot - mu[s]) / sdEff;
    const slug = species[s];
    const rawShape = pokedex[slug]?.shape ?? "";
    const shape = OVERRIDE_BALL_SLUGS.has(slug) ? "ball" : rawShape;

    // Filter out non-humanoid shapes (fish, ball, bug, quadruped) and persistent false hubs
    if (NON_HUMAN_EXCLUDE_SHAPES.has(shape) || HUB_EXCLUDE_SLUGS.has(slug)) {
      scored[s] = { i: s, z: -999 };
      continue;
    }

    let boost = CHAR_SHAPE_BOOST[shape] ?? 0;
    if (faceAspect > 1.15) {
      if (shape === "humanoid" || shape === "upright") {
        boost += 0.15;
      }
    }

    const z = rawZ + boost;
    scored[s] = { i: s, z };
    sum += z;
  }
  // Per-face z standardization for the displayed percent (ranking uses the
  // raw z, which this transform preserves — it's monotonic).
  const meanZ = sum / n;
  let varSum = 0;
  for (const { z } of scored) varSum += (z - meanZ) ** 2;
  const stdZ = Math.sqrt(varSum / n) || 1;

  scored.sort((a, b) => b.z - a.z);
  const topSlice = scored.slice(0, k);
  const topSz = topSlice.length > 0 ? (topSlice[0].z - meanZ) / stdZ : 0;

  return topSlice.map(({ i, z }) => {
    const slug = species[i];
    const sz = (z - meanZ) / stdZ;
    const entry = pokedex[slug] ?? null;
    const percent = zToPercent(sz, topSz);
    const subAnalysis = computeSubAnalysis(entry, percent, faceAspect);

    return { slug, entry, z, percent, subAnalysis };
  });
}
