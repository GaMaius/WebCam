import test from "node:test";
import assert from "node:assert/strict";
import { makeRng, orderCandidatesForJudge, shuffled } from "../lib/pokematch/candidateOrder.ts";
import type { PokematchCandidate } from "../lib/pokematch/matcher.ts";

// The ordering decides the answer (see candidateOrder.ts for the three
// orderings tried and what each one measured). What these pin: it is stable
// regardless of scores, and it is not dex order.

const POOL = [
  "bulbasaur", "jigglypuff", "meowth", "mew", "nidoran",
  "onix", "persian", "sprigatito", "vaporeon", "wigglytuff",
  "pikachu", "eevee", "riolu", "zorua", "umbreon",
  "gengar", "lucario", "absol", "sylveon", "chespin",
];

/** A scored pool, top-ranked by the given slugs. */
function candidates(topSlugs: string[], jitter = 0): PokematchCandidate[] {
  return POOL.map((slug) => {
    const rank = topSlugs.indexOf(slug);
    const z = rank >= 0 ? 2 - rank * 0.1 + jitter : -1 + jitter;
    return { slug, z, entry: null } as unknown as PokematchCandidate;
  });
}

// Three consecutive scans of one face, real top-species lists off ?debug.
// Scans 1 and 2 agree; scan 3 swaps onix and bulbasaur for mewtwo and
// nidorina. That churn is what broke the previous per-face seed, so the
// ordering must not depend on these at all.
const SCAN_1 = ["jigglypuff", "mew", "persian", "onix", "wigglytuff", "sprigatito", "vaporeon", "meowth", "bulbasaur", "nidoran"];
const SCAN_2 = ["jigglypuff", "mew", "persian", "wigglytuff", "sprigatito", "meowth", "onix", "vaporeon", "nidoran", "bulbasaur"];
const SCAN_3 = ["jigglypuff", "mew", "persian", "wigglytuff", "vaporeon", "meowth", "sprigatito", "nidoran", "eevee", "pikachu"];

test("scores do not affect the ordering, so a rescan cannot re-roll the answer", () => {
  const orders = [
    orderCandidatesForJudge(candidates(SCAN_1)),
    orderCandidatesForJudge(candidates(SCAN_2, 0.37)),
    orderCandidatesForJudge(candidates(SCAN_3, -0.21)),
  ].map((o) => o.map((c) => c.slug));

  assert.deepEqual(orders[0], orders[1]);
  assert.deepEqual(
    orders[0],
    orders[2],
    "scan 3 changed which species rank top — that must not change the ordering"
  );
});

test("the ordering is a permutation — nothing added, dropped or duplicated", () => {
  const scored = candidates(SCAN_1);
  const out = orderCandidatesForJudge(scored);
  assert.equal(out.length, scored.length);
  assert.deepEqual(
    out.map((c) => c.slug).sort(),
    scored.map((c) => c.slug).sort()
  );
});

test("the ordering is not dex order — that correlation is the one being broken", () => {
  const scored = candidates(SCAN_1);
  const out = orderCandidatesForJudge(scored);
  const moved = out.filter((c, i) => c.slug !== scored[i].slug).length;
  assert.ok(moved > scored.length / 2, `only ${moved} of ${scored.length} moved`);
});

test("the input array is left alone", () => {
  const scored = candidates(SCAN_1);
  const before = scored.map((c) => c.slug);
  orderCandidatesForJudge(scored);
  assert.deepEqual(scored.map((c) => c.slug), before);
});

test("a seeded generator replays exactly, and different seeds diverge", () => {
  const draw = (rng: () => number) => Array.from({ length: 5 }, rng);
  assert.deepEqual(draw(makeRng(1234)), draw(makeRng(1234)));
  assert.notDeepEqual(draw(makeRng(1234)), draw(makeRng(5678)));
});

test("shuffled covers every position over many seeds, so no slot is dead", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  const seen = new Set<string>();
  for (let seed = 0; seed < 200; seed++) {
    seen.add(shuffled(items, makeRng(seed))[0].toString());
  }
  assert.equal(seen.size, items.length, `only ${seen.size} distinct values ever led`);
});
