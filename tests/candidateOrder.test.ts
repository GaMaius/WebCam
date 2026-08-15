import test from "node:test";
import assert from "node:assert/strict";
import {
  faceSeed,
  makeRng,
  orderCandidatesForJudge,
  shuffled,
} from "../lib/pokematch/candidateOrder.ts";
import type { PokematchCandidate } from "../lib/pokematch/matcher.ts";

// The ordering decides the answer (see candidateOrder.ts), so these pin the
// two properties it has to hold at once: stable for one face, different
// between faces, and never correlated with dex position.

const POOL = [
  "bulbasaur", "jigglypuff", "meowth", "mew", "nidoran",
  "onix", "persian", "sprigatito", "vaporeon", "wigglytuff",
  "pikachu", "eevee", "riolu", "zorua", "umbreon",
  "gengar", "lucario", "absol", "sylveon", "chespin",
];

/** A scored pool, top-10 chosen by the given slugs. */
function candidates(topSlugs: string[], jitter = 0): PokematchCandidate[] {
  return POOL.map((slug) => {
    const rank = topSlugs.indexOf(slug);
    const z = rank >= 0 ? 2 - rank * 0.1 + jitter : -1 + jitter;
    return { slug, z, entry: null } as unknown as PokematchCandidate;
  });
}

// Real z values off three consecutive scans of one face: every value moved,
// but the same ten species stayed on top. That is what the seed reads.
const FACE_A = ["jigglypuff", "mew", "persian", "onix", "wigglytuff", "sprigatito", "vaporeon", "meowth", "bulbasaur", "nidoran"];
const FACE_A_RESCAN = ["jigglypuff", "mew", "persian", "wigglytuff", "sprigatito", "meowth", "onix", "vaporeon", "nidoran", "bulbasaur"];
const FACE_B = ["riolu", "zorua", "umbreon", "lucario", "absol", "gengar", "eevee", "pikachu", "sylveon", "chespin"];

test("the same face gets the same ordering, even though every z moved", () => {
  // Same ten species, different order and different magnitudes — a rescan.
  const first = orderCandidatesForJudge(candidates(FACE_A));
  const second = orderCandidatesForJudge(candidates(FACE_A_RESCAN, 0.37));

  assert.deepEqual(
    first.map((c) => c.slug),
    second.map((c) => c.slug),
    "a rescan must not re-roll which species the judge lands on"
  );
});

test("a different face gets a different ordering", () => {
  const a = orderCandidatesForJudge(candidates(FACE_A)).map((c) => c.slug);
  const b = orderCandidatesForJudge(candidates(FACE_B)).map((c) => c.slug);
  assert.notDeepEqual(a, b, "no species may sit at a fixed position for everyone");
});

test("the ordering is a permutation — nothing added, dropped or duplicated", () => {
  const scored = candidates(FACE_A);
  const out = orderCandidatesForJudge(scored);
  assert.equal(out.length, scored.length);
  assert.deepEqual(
    out.map((c) => c.slug).sort(),
    scored.map((c) => c.slug).sort()
  );
});

test("the ordering actually moves things, rather than returning dex order", () => {
  const scored = candidates(FACE_A);
  const out = orderCandidatesForJudge(scored);
  const moved = out.filter((c, i) => c.slug !== scored[i].slug).length;
  assert.ok(moved > scored.length / 2, `only ${moved} of ${scored.length} moved`);
});

test("the input array is left alone", () => {
  const scored = candidates(FACE_A);
  const before = scored.map((c) => c.slug);
  orderCandidatesForJudge(scored);
  assert.deepEqual(scored.map((c) => c.slug), before);
});

test("the seed ignores tie-break order among the same top species", () => {
  assert.equal(faceSeed(candidates(FACE_A)), faceSeed(candidates(FACE_A_RESCAN, 0.37)));
});

test("a seeded generator replays exactly, and different seeds diverge", () => {
  const a = makeRng(1234);
  const b = makeRng(1234);
  const c = makeRng(5678);
  const draw = (rng: () => number) => Array.from({ length: 5 }, rng);
  assert.deepEqual(draw(a), draw(b));
  assert.notDeepEqual(draw(makeRng(1234)), draw(c));
});

test("shuffled covers every position over many seeds, so no slot is dead", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  const seen = new Set<string>();
  for (let seed = 0; seed < 200; seed++) {
    seen.add(shuffled(items, makeRng(seed))[0].toString());
  }
  assert.equal(seen.size, items.length, `only ${seen.size} distinct values ever led`);
});
