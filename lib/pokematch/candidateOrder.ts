// The order candidates are presented to the vision judge in.
//
// This is not a cosmetic detail — it measurably decides the answer, and the
// two obvious choices are both wrong:
//
//   Dex order (the original) put gen 1 at the front, and the judge answered
//   from the front: one run picked candidates 23, 36, 51, 53 and 57 out of
//   291, which random choice produces about 4 times in 10,000. The bias hid
//   because the top of the list is also where the famous round designs live,
//   so "first" and "obvious" were the same species.
//
//   Plain random order fixed that and broke something else: two scans of one
//   face shared none of their five picks. Many species plausibly fit "sharp
//   eyes, glasses, dark hair", and a fresh ordering re-rolled which of them
//   the judge landed on. A lookalike should be a property of the face, not a
//   dice roll.
//
// So: shuffled, but seeded from the face. Position stays uncorrelated with dex
// across users, while one person keeps one ordering.
//
// Kept out of the hook so `node --test` can reach it; the hook imports React.

import type { PokematchCandidate } from "./matcher";

/** FNV-1a. Small, dependency-free, and only needs to spread similar inputs. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — a seeded PRNG, so a shuffle can be reproduced. */
export function makeRng(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates copy, driven by a supplied generator. */
export function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** How many top-scoring species identify the face for seeding purposes. */
const SEED_SPECIES = 10;

/**
 * A seed derived from the face itself.
 *
 * Built from which species score highest rather than from the embedding
 * floats: those move a little every frame, whereas the top of the ranking is
 * stable for one person. Measured across three consecutive scans of the same
 * face, the top ten were the same ten species every time, while the raw z
 * values all differed.
 *
 * Sorted before hashing so near-equal scores swapping places doesn't change
 * the seed.
 */
export function faceSeed(candidates: PokematchCandidate[]): number {
  const top = [...candidates]
    .sort((a, b) => b.z - a.z)
    .slice(0, SEED_SPECIES)
    .map((c) => c.slug)
    .sort();
  return hashString(top.join(","));
}

/** The candidate array to number the prompt with and resolve the reply
 * against. Must be used for both — see judgeProtocol. */
export function orderCandidatesForJudge(scored: PokematchCandidate[]): PokematchCandidate[] {
  return shuffled(scored, makeRng(faceSeed(scored)));
}
