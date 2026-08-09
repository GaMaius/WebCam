import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CURATED_POOL, CURATED_SLUGS, isCurated, lookFor } from "../lib/pokematch/curatedPool.ts";
import { buildUserPrompt, sanitizeCandidates } from "../lib/pokematch/judgeProtocol.ts";

// The curated pool is the set of answers this app is willing to give. A slug
// that isn't in the shipped gallery would be picked by the judge and then
// render as a broken row with no sprite, so that's checked against the real
// asset files rather than assumed.

const root = fileURLToPath(new URL("..", import.meta.url));
const pokedex = JSON.parse(readFileSync(root + "public/pokemon/pokedex.json", "utf8")) as Record<
  string,
  { nameKo: string | null; shape: string | null }
>;
const gallery = JSON.parse(readFileSync(root + "public/pokemon/gallery.json", "utf8")) as {
  species: string[];
};

test("every curated slug exists in both the pokedex and the shipped gallery", () => {
  const inGallery = new Set(gallery.species);
  for (const { slug } of CURATED_POOL) {
    assert.ok(pokedex[slug], `${slug} is not in pokedex.json`);
    assert.ok(inGallery.has(slug), `${slug} has no embedding in gallery.json`);
  }
});

test("the pool has no duplicates and is the size the token budget assumes", () => {
  assert.equal(new Set(CURATED_SLUGS).size, CURATED_SLUGS.length, "duplicate slug in the pool");
  assert.equal(CURATED_POOL.length, 40);
});

test("every entry carries a look description — the judge cannot see sprites", () => {
  for (const { slug, look } of CURATED_POOL) {
    assert.ok(look && look.length >= 10, `${slug} has no usable look description`);
    assert.ok(look.length <= 80, `${slug}'s look text will be truncated in transit`);
  }
});

test("the pool spans distinct impressions rather than 40 variations of one", () => {
  // Shape is a crude proxy, but if the pool collapsed onto one silhouette every
  // face would land in the same place — which is the failure this pool exists
  // to avoid.
  const shapes = new Set(CURATED_SLUGS.map((s) => pokedex[s]?.shape ?? "?"));
  assert.ok(shapes.size >= 5, `only ${shapes.size} distinct shapes in the pool`);
});

test("none of the known-insulting species made it in", () => {
  // Somebody's face is the input. See the exclusion note in curatedPool.ts.
  const banned = ["muk", "grimer", "garbodor", "trubbish", "snorlax", "slowpoke", "magikarp", "hypno", "koffing", "weezing"];
  for (const slug of banned) {
    assert.ok(!isCurated(slug), `${slug} should not be a result this app hands someone`);
  }
});

test("lookFor / isCurated only answer for pool members", () => {
  assert.ok(isCurated("pikachu"));
  assert.ok(lookFor("pikachu"));
  assert.equal(isCurated("bulbasaur"), false);
  assert.equal(lookFor("bulbasaur"), undefined);
});

test("the prompt separates the curated pool from wildcards and labels the preference", () => {
  const candidates = sanitizeCandidates([
    { slug: "pikachu", nameKo: "피카츄", look: lookFor("pikachu"), curated: true, z: 2.1 },
    { slug: "lucario", nameKo: "루카리오", look: lookFor("lucario"), curated: true, z: 1.9 },
    { slug: "bulbasaur", nameKo: "이상해씨", shape: "quadruped", curated: false, z: 2.4 },
  ]);
  const prompt = buildUserPrompt("얼굴형: 계란형", candidates);

  const curatedAt = prompt.indexOf("[추천 목록");
  const wildAt = prompt.indexOf("[그 외 후보");
  assert.ok(curatedAt > -1 && wildAt > curatedAt, "curated section must come first");
  assert.ok(prompt.includes("되도록 여기서 고르세요"));
  assert.ok(prompt.includes("최대 1마리"));

  // The look text has to reach the model — it's the only appearance info it gets.
  assert.ok(prompt.includes("볼이 도톰"), prompt);
  // Wildcards have no look text, so they keep the coarse type/shape hints.
  assert.ok(prompt.slice(wildAt).includes("quadruped"));
  // A wildcard must not be silently promoted into the curated section.
  assert.ok(!prompt.slice(curatedAt, wildAt).includes("이상해씨"));
});
