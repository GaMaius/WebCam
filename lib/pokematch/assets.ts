// PokéMatch asset URLs.
//
// Big files (the ONNX encoder ~44MB and the 1000+ representative images) are
// kept OUT of the git repo and hosted on B2. Set NEXT_PUBLIC_POKEMATCH_ASSET_BASE
// (inlined at build time) to the bucket's public base URL, e.g.
//   https://f003.backblazeb2.com/file/<bucket>
// and upload the files preserving these paths:
//   <base>/models/pokemon_encoder.onnx
//   <base>/pokemon/img/<slug>.webp
// When the var is unset (local dev), everything falls back to /public.
//
// Small files (gallery.bin/json, pokedex.json) always stay in /public — they
// are committed to the repo. This module has NO onnxruntime dependency so
// lib/resultCard can import it too.

const BASE = (process.env.NEXT_PUBLIC_POKEMATCH_ASSET_BASE ?? "").replace(/\/+$/, "");

export const ENCODER_URL = BASE
  ? `${BASE}/models/pokemon_encoder.onnx`
  : "/models/pokemon_encoder.onnx";

export const GALLERY_BIN = "/pokemon/gallery.bin";
export const GALLERY_JSON = "/pokemon/gallery.json";
export const POKEDEX_JSON = "/pokemon/pokedex.json";

/** Base for representative images: `${base}/<slug>.webp`. */
export const POKEMATCH_IMG_BASE = BASE ? `${BASE}/pokemon/img` : "/pokemon/img";

/** Encoder input side (open_clip preprocess: resize+center-crop 256, [0,1] RGB). */
export const POKEMATCH_IMG_SIZE = 256;

export function pokemonImageUrl(slug: string): string {
  return `${POKEMATCH_IMG_BASE}/${slug}.webp`;
}
