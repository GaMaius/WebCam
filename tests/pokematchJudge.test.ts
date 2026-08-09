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

const allowed = new Set(["pikachu", "gengar", "lucario", "gardevoir", "eevee"]);

test("picks outside the shortlist are dropped — they have no image or pokedex entry", () => {
  const picks = normalizePicks(
    {
      picks: [
        { slug: "pikachu", percent: 92, reason: "a" },
        { slug: "missingno", percent: 88, reason: "hallucinated" },
        { slug: "gengar", percent: 85, reason: "b" },
      ],
    },
    allowed
  );
  assert.deepEqual(
    picks.map((p) => p.slug),
    ["pikachu", "gengar"]
  );
});

test("duplicate picks collapse", () => {
  const picks = normalizePicks(
    { picks: [{ slug: "eevee", percent: 90 }, { slug: "EEVEE", percent: 80 }] },
    allowed
  );
  assert.equal(picks.length, 1);
});

test("percentages are forced strictly descending even if the model ignores that", () => {
  const picks = normalizePicks(
    {
      picks: [
        { slug: "pikachu", percent: 80 },
        { slug: "gengar", percent: 95 }, // higher than the winner
        { slug: "lucario", percent: 95 }, // tied
      ],
    },
    allowed
  );
  assert.deepEqual(picks.map((p) => p.percent), [80, 77, 74]);
  for (let i = 1; i < picks.length; i++) {
    assert.ok(picks[i].percent < picks[i - 1].percent);
  }
});

test("percent is clamped and non-numeric values don't produce NaN", () => {
  const picks = normalizePicks(
    { picks: [{ slug: "pikachu", percent: 1000 }, { slug: "gengar", percent: "삼십" }] },
    allowed
  );
  assert.equal(picks[0].percent, 99);
  assert.ok(Number.isInteger(picks[1].percent));
});

test("no more than the requested number of picks come back", () => {
  const picks = normalizePicks(
    { picks: [...allowed].concat([...allowed]).map((slug, i) => ({ slug, percent: 95 - i })) },
    allowed
  );
  assert.ok(picks.length <= PICK_COUNT);
});

test("JSON survives code fences, reasoning tags and surrounding prose", () => {
  const wrapped = '<think>고민 중</think>\n결과입니다:\n```json\n{"picks":[{"slug":"pikachu","percent":91}]}\n```\n끝!';
  const parsed = extractJson(wrapped);
  assert.deepEqual(normalizePicks(parsed, allowed).map((p) => p.slug), ["pikachu"]);
});

test("unparseable output yields no picks rather than a broken result", () => {
  assert.equal(extractJson("모델이 그냥 말로 대답했습니다"), null);
  assert.deepEqual(normalizePicks(null, allowed), []);
});

test("a bare array of picks is accepted too", () => {
  const picks = normalizePicks([{ slug: "lucario", percent: 88, reason: "x" }], allowed);
  assert.equal(picks[0].slug, "lucario");
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

test("the prompt lists every candidate slug the model is allowed to pick", () => {
  const clean = sanitizeCandidates([
    { slug: "pikachu", nameKo: "피카츄", nameEn: "Pikachu", types: ["전기"], shape: "quadruped", z: 2.1 },
    { slug: "gengar", nameKo: "팬텀", types: ["고스트", "독"], z: 1.8 },
  ]);
  const prompt = buildUserPrompt("얼굴형: 계란형", clean);
  assert.ok(prompt.includes("slug=pikachu"));
  assert.ok(prompt.includes("slug=gengar"));
  assert.ok(prompt.includes("얼굴형: 계란형"));
});

test("an over-long description is truncated before it reaches the prompt", () => {
  const prompt = buildUserPrompt("가".repeat(9000), sanitizeCandidates([{ slug: "pikachu" }]));
  assert.ok(prompt.length < 6000, `prompt was ${prompt.length} chars`);
});
