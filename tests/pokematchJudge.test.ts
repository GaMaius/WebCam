import test from "node:test";
import assert from "node:assert/strict";
import {
  PICK_COUNT,
  buildUserPrompt,
  extractJson,
  normalizePicks,
  sanitizeCandidates,
} from "../lib/pokematch/judgeProtocol.ts";

// The judge is an LLM, so its output is untrusted input. Everything the prompt
// asks for is re-checked here; these tests pin that, not the model's manners.

// Candidates are addressed by 1-based number in the order given to
// buildUserPrompt — normalizePicks must resolve against that same array.
const candidates = sanitizeCandidates(
  ["pikachu", "gengar", "lucario", "gardevoir", "eevee"].map((slug) => ({ slug, curated: true }))
);

test("numbers resolve to the candidate at that position", () => {
  const picks = normalizePicks({ picks: [{ n: 3, reason: "a" }, { n: 1, reason: "b" }] }, candidates);
  assert.deepEqual(picks.map((p) => p.slug), ["lucario", "pikachu"]);
  assert.equal(picks[0].reason, "a");
});

test("out-of-range numbers are dropped — an invented id can't resolve to anything", () => {
  const picks = normalizePicks(
    { picks: [{ n: 2 }, { n: 999 }, { n: 0 }, { n: -1 }, { n: 5 }] },
    candidates
  );
  assert.deepEqual(picks.map((p) => p.slug), ["gengar", "eevee"]);
});

test("duplicate picks collapse", () => {
  const picks = normalizePicks({ picks: [{ n: 5 }, { n: 5 }, { slug: "EEVEE" }] }, candidates);
  assert.equal(picks.length, 1);
});

test("a legacy slug object still works, and an unknown slug still doesn't", () => {
  const picks = normalizePicks(
    { picks: [{ slug: "lucario", reason: "x" }, { slug: "missingno" }] },
    candidates
  );
  assert.deepEqual(picks.map((p) => p.slug), ["lucario"]);
});

test("a bare array of numbers is accepted too", () => {
  const picks = normalizePicks([4, 2], candidates);
  assert.deepEqual(picks.map((p) => p.slug), ["gardevoir", "gengar"]);
});

test("no more than the requested number of picks come back", () => {
  const picks = normalizePicks([1, 2, 3, 4, 5, 1, 2, 3], candidates);
  assert.ok(picks.length <= PICK_COUNT);
});

test("the model is not asked for a percent, and never supplies one", () => {
  const picks = normalizePicks({ picks: [{ n: 1, percent: 93 }] }, candidates);
  assert.ok(!("percent" in picks[0]), "percent must be computed from z, not taken from the model");
});

test("JSON survives code fences, reasoning tags and surrounding prose", () => {
  const wrapped = '<think>고민 중</think>\n결과입니다:\n```json\n{"picks":[{"n":1,"reason":"ㅇㅇ"}]}\n```\n끝!';
  assert.deepEqual(normalizePicks(extractJson(wrapped), candidates).map((p) => p.slug), ["pikachu"]);
});

test("unparseable output yields no picks rather than a broken result", () => {
  assert.equal(extractJson("모델이 그냥 말로 대답했습니다"), null);
  assert.deepEqual(normalizePicks(null, candidates), []);
});

test("candidate sanitizing rejects unsafe slugs and caps the list", () => {
  const raw = [
    { slug: "pikachu", nameKo: "피카츄" },
    { slug: "../../etc/passwd" },
    { slug: "Has Spaces" },
    { slug: "pikachu" }, // dupe
    null,
    "nope",
    { slug: "muk_alola", z: 1.23456 },
  ];
  const clean = sanitizeCandidates(raw);
  assert.deepEqual(clean.map((c) => c.slug), ["pikachu", "muk_alola"]);
  assert.equal(clean[1].z, 1.23);
});

test("the prompt numbers candidates and contains no English identifiers", () => {
  const clean = sanitizeCandidates([
    { slug: "pikachu", nameKo: "피카츄", nameEn: "Pikachu", look: "동그란 얼굴", curated: true, z: 2.1 },
    { slug: "gengar", nameKo: "팬텀", nameEn: "Gengar", look: "장난기 어린 미소", curated: true, z: 1.8 },
  ]);
  const prompt = buildUserPrompt("얼굴형: 계란형", clean);

  assert.ok(prompt.includes("1. 피카츄"));
  assert.ok(prompt.includes("2. 팬텀"));
  assert.ok(prompt.includes("얼굴형: 계란형"));
  // English costs tokens and buys nothing — `look` is what the judge matches on.
  assert.ok(!/[A-Za-z]{3,}/.test(prompt), `English leaked into the prompt: ${prompt}`);
});

test("numbering is global, so splitting into sections doesn't shift it", () => {
  const clean = sanitizeCandidates([
    { slug: "pikachu", nameKo: "피카츄", look: "동그란 얼굴", curated: true },
    { slug: "bulbasaur", nameKo: "이상해씨", shape: "quadruped", curated: false },
    { slug: "gengar", nameKo: "팬텀", look: "장난기 어린 미소", curated: true },
  ]);
  const prompt = buildUserPrompt("얼굴형: 계란형", clean);
  // The wildcard is printed last but keeps its array position (2).
  assert.ok(prompt.includes("2. 이상해씨"), prompt);
  assert.ok(prompt.includes("3. 팬텀"), prompt);
  assert.ok(prompt.indexOf("3. 팬텀") < prompt.indexOf("2. 이상해씨"), "sections out of order");
  // And that number still resolves to the wildcard, not to the 2nd curated entry.
  assert.equal(normalizePicks([2], clean)[0].slug, "bulbasaur");
});

test("an over-long description is truncated before it reaches the prompt", () => {
  const prompt = buildUserPrompt("가".repeat(9000), sanitizeCandidates([{ slug: "pikachu" }]));
  assert.ok(prompt.length < 6000, `prompt was ${prompt.length} chars`);
});
