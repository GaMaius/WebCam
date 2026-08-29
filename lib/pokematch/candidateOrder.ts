// The order candidates are presented to the vision judge in.
//
// Not cosmetic — it measurably decides the answer. Three orderings have been
// tried on real scans, and the history matters because two of them look
// obviously right until you measure them:
//
//   1. DEX ORDER (original). The judge answered from the front: one run picked
//      candidates 23, 36, 51, 53 and 57 out of 291, which random choice
//      produces about 4 times in 10,000. It hid because the front of a dex
//      list is gen 1, which is also where the famous round designs live — so
//      "first" and "the obvious cute answer" were the same species, and the
//      skew read as taste rather than as an artifact.
//
//   2. RESHUFFLED EVERY SCAN. Killed that, and made the result a dice roll:
//      consecutive scans of one face shared none of their five picks, because
//      dozens of species plausibly fit "sharp eyes, glasses, dark hair" and a
//      new ordering re-rolled which one surfaced.
//
//   3. SHUFFLED FROM A PER-FACE SEED, hashed from the top-10 species by z.
//      The idea was one ordering per person. It does not hold: z values in the
//      curated pool bunch between 0.0 and 0.5, so species near rank 10 swap in
//      and out between scans and take the whole seed with them. Measured on
//      one face — scans 1 and 2 agreed, scan 3 replaced onix and bulbasaur
//      with mewtwo and nidorina, a different seed and therefore a different
//      answer. Hashing a noisy continuous ranking into a discrete seed is
//      unstable by construction; any cutoff has a boundary and the boundary
//      churns.
//
// So: ONE FIXED PERMUTATION, the same for every scan and every user.
//
// What that buys and costs, stated plainly. It removes the correlation that
// actually did damage — position no longer tracks generation, fame or
// roundness, so the list's head is not a coherent aesthetic the judge can slide
// toward. It is perfectly reproducible, which is what a lookalike has to be.
// It does leave a fixed positional preference: if the judge favours low
// numbers at all, it favours the same arbitrary species for everyone. That is
// the known risk to watch, and it is watchable — ?debug prints each pick's
// candidate number, so a drift toward low numbers across different people is
// visible. Prefer this over reintroducing per-scan randomness.
//
// Kept out of the hook so `node --test` can reach it; the hook imports React.

import type { PokematchCandidate } from "./matcher";

/** Arbitrary constant. Its only job is to be fixed — any value works, and
 * changing it reshuffles everyone's results for no gain, so don't. */
const JUDGE_ORDER_SEED = 0x5eed1e;

/** mulberry32 — a seeded PRNG, so the permutation is reproducible. */
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

/**
 * The candidate array to number the prompt with and resolve the reply against.
 * Must be the same array for both — see judgeProtocol.
 *
 * Depends only on which species are in the pool, never on their scores, so the
 * same pool always yields the same ordering.
 */
export function orderCandidatesForJudge(scored: PokematchCandidate[]): PokematchCandidate[] {
  return shuffled(scored, makeRng(JUDGE_ORDER_SEED));
}
