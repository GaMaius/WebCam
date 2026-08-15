import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BANNED_SLUGS,
  EXTRA_FAMOUS,
  JUDGE_DEFAULT_SLUGS,
  buildCuratedPool,
} from "../lib/pokematch/curatedPool.ts";
import { buildCandidateList, sanitizeCandidates } from "../lib/pokematch/judgeProtocol.ts";

// The curated pool is the set of answers this app is willing to give. It's
// computed from the shipped pokedex, so these tests run against the real asset
// files — a slug that isn't actually there would be picked by the judge and
// then render as a broken row with no sprite.

const root = fileURLToPath(new URL("..", import.meta.url));
import type { PokedexEntry } from "../lib/pokematch/matcher.ts";
const pokedex = JSON.parse(readFileSync(root + "public/pokemon/pokedex.json", "utf8")) as Record<
  string,
  PokedexEntry
>;
const gallery = JSON.parse(readFileSync(root + "public/pokemon/gallery.json", "utf8")) as { species: string[] };
const available = new Set(gallery.species);
const pool = buildCuratedPool(pokedex, available);

test("the pool is large enough to be worth judging over", () => {
  // The ask was "at least ~200". Below that we're back to a shortlist that
  // decides the answer before the judge sees it.
  assert.ok(pool.length >= 200, `pool is only ${pool.length} species`);
});

test("every pooled slug exists in both the pokedex and the shipped gallery", () => {
  for (const slug of pool) {
    assert.ok(pokedex[slug], `${slug} is not in pokedex.json`);
    assert.ok(available.has(slug), `${slug} has no embedding in gallery.json`);
  }
});

test("every EXTRA_FAMOUS slug is real — a typo would silently vanish", () => {
  // buildCuratedPool filters unknown slugs, so a misspelling costs a species
  // with no error anywhere. This is the only thing that catches it.
  const bogus = [...new Set(EXTRA_FAMOUS)].filter((s) => !pokedex[s] || !available.has(s));
  assert.deepEqual(bogus, [], `unknown slugs in EXTRA_FAMOUS: ${bogus.join(", ")}`);
});

test("no banned species reaches the pool", () => {
  // Somebody's face is the input. See the exclusion note in curatedPool.ts.
  for (const slug of pool) {
    assert.ok(!BANNED_SLUGS.has(slug), `${slug} should not be a result this app hands someone`);
  }
  for (const slug of ["muk", "snorlax", "magikarp", "hypno", "jynx", "ditto"]) {
    assert.ok(!pool.includes(slug), `${slug} leaked into the pool`);
  }
});

test("the pool has no duplicates and is ordered by dex", () => {
  assert.equal(new Set(pool).size, pool.length, "duplicate slug in the pool");
  const dexes = pool.map((s) => pokedex[s].dex ?? 9999);
  for (let i = 1; i < dexes.length; i++) {
    assert.ok(dexes[i] >= dexes[i - 1], `pool is not dex-ordered at index ${i}`);
  }
});

test("ordering is deterministic — the judge answers with positions in this list", () => {
  assert.deepEqual(buildCuratedPool(pokedex, available), pool);
});

test("the pool spans distinct impressions rather than variations of one", () => {
  const shapes = new Set(pool.map((s) => pokedex[s]?.shape ?? "?"));
  assert.ok(shapes.size >= 8, `only ${shapes.size} distinct shapes in the pool`);
});

test("recognizable staples are present", () => {
  for (const slug of ["pikachu", "charizard", "gengar", "eevee", "lucario", "gardevoir", "mimikyu"]) {
    assert.ok(pool.includes(slug), `${slug} should be in the pool`);
  }
});

test("the numbered list stays affordable and carries only English names", () => {
  const candidates = sanitizeCandidates(
    pool.map((slug) => ({ slug, nameEn: pokedex[slug].nameEn, nameKo: pokedex[slug].nameKo }))
  );
  assert.equal(candidates.length, pool.length, "sanitizeCandidates dropped pool members");

  const list = buildCandidateList(candidates);
  assert.ok(list.startsWith("1.Bulbasaur"), list.slice(0, 40));
  // Korean names are ~25% more tokens here and the model's species knowledge is
  // anchored to English — the Korean name is resolved back on our side.
  assert.ok(!/[가-힣]/.test(list), "Korean leaked into the candidate list");
  // Rough token proxy: the list must stay small enough to fit the free tier's
  // 8K per-minute ceiling alongside the image and the system prompt.
  assert.ok(list.length / 4 < 2500, `candidate list is ~${Math.round(list.length / 4)} tokens`);
});

// ⚠️ This option is DORMANT — the app does not pass it. Excluding the mascots
// was tried and backfired (the judge moved to Porygon/Staryu rather than to
// anything more personal); see JUDGE_DEFAULT_SLUGS. The test stays so the
// mechanism still works if a future change makes it worth re-enabling.
test("buildCuratedPool can drop the judge's default mascots when asked", () => {
  const withDefaults = buildCuratedPool(pokedex, available);
  const forJudge = buildCuratedPool(pokedex, available, { excludeJudgeDefaults: true });

  assert.ok(withDefaults.includes("pikachu"), "fixture sanity: pikachu is normally in the pool");
  for (const slug of JUDGE_DEFAULT_SLUGS) {
    assert.ok(!forJudge.includes(slug), `${slug} must not reach the judge`);
  }
  assert.ok(
    forJudge.length > withDefaults.length - JUDGE_DEFAULT_SLUGS.size - 1,
    "only the listed defaults may be removed"
  );
});
