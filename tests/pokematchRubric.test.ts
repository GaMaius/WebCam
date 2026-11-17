// "One shared feature is not resemblance" (2026-11-17). The user reported that
// once reasons had to name a concrete feature, the judge started picking
// species on ONE feature — glasses → anything with eye rings. These tests pin
// the two defences: stage 1's self-reported "match" breadth, and stage 2's
// graded rubric, combined in code.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MATCH_SLOTS,
  SINGLE_FEATURE_PENALTY,
  SYSTEM_PROMPT,
  buildRerankSystemPrompt,
  extractTraits,
  normalizePicks,
  normalizeRerank,
  preferBroadMatches,
  rubricScore,
} from "../lib/pokematch/judgeProtocol.ts";

const candidates = [
  { slug: "riolu", nameEn: "Riolu" },
  { slug: "zorua", nameEn: "Zorua" },
  { slug: "spheal", nameEn: "Spheal" },
  { slug: "pancham", nameEn: "Pancham" },
  { slug: "absol", nameEn: "Absol" },
];

test("rubric: one striking feature loses to two clear ones", () => {
  // Glasses vs eye rings, nothing else in common — the reported failure.
  const single = rubricScore({ hair: 0, eyes: 0, face: 0, colors: 0, accessory: 3, overall: 6 });
  // Hair and colours clearly shared, no accessory match.
  const double = rubricScore({ hair: 2, eyes: 1, face: 0, colors: 2, accessory: 0, overall: 5 });
  assert.ok(double > single, `double ${double} should beat single ${single}`);
});

test("rubric: the penalty applies below two clear features, not at two", () => {
  const one = rubricScore({ hair: 2, eyes: 1, face: 1, colors: 1, accessory: null, overall: 5 });
  const two = rubricScore({ hair: 2, eyes: 2, face: 1, colors: 1, accessory: null, overall: 5 });
  assert.equal(two - one, 1 + SINGLE_FEATURE_PENALTY);
});

test("rubric: the holistic grade still counts — it is not just a feature sum", () => {
  const sameFeaturesHighOverall = rubricScore({ hair: 2, eyes: 2, face: 1, colors: 1, accessory: null, overall: 9 });
  const sameFeaturesLowOverall = rubricScore({ hair: 2, eyes: 2, face: 1, colors: 1, accessory: null, overall: 3 });
  assert.ok(sameFeaturesHighOverall > sameFeaturesLowOverall);
});

test("rerank: graded answers are ordered by the combined score, not the listing", () => {
  const out = normalizeRerank(
    {
      scores: [
        // Listed first, but only the glasses match.
        { n: 1, hair: 0, eyes: 0, face: 0, colors: 0, accessory: 3, overall: 6, reason: "안경 테가 눈 무늬와 닮았어요" },
        { n: 2, hair: 2, eyes: 2, face: 1, colors: 2, accessory: 0, overall: 6, reason: "검은 앞머리와 눈매가 닮았어요" },
        // Lower overall, but two features clearly shared.
        { n: 3, hair: 2, eyes: 0, face: 0, colors: 2, accessory: 0, overall: 4 },
      ],
    },
    4
  );
  assert.deepEqual(out.map((e) => e.n), [2, 3, 1, 4]);
  assert.equal(out[0].grades, "h2 e2 f1 c2 a0 o6");
  assert.equal(out[3].score, undefined, "an ungraded missing panel sinks to the end");
});

test("rerank: out-of-range grades are clamped, junk becomes 0", () => {
  const [e] = normalizeRerank({ scores: [{ n: 1, hair: 9, eyes: -2, face: "x", colors: 2, overall: 99 }] }, 1);
  assert.equal(e.grades, "h3 e0 f0 c2 a- o10");
});

test("rerank: legacy order answers keep the listed order", () => {
  const out = normalizeRerank({ order: [{ n: 3 }, { n: 1 }] }, 3);
  assert.deepEqual(out.map((e) => e.n), [3, 1, 2]);
});

test("stage 1: match slots are parsed, normalized and filtered", () => {
  const picks = normalizePicks(
    {
      picks: [
        { name: "Riolu", match: ["hair", "Colour", "eye"], reason: "a" },
        { name: "Spheal", match: ["glasses", "mood"], reason: "b" },
        { name: "Zorua", reason: "c" },
      ],
    },
    candidates
  );
  assert.deepEqual(picks[0].match, ["hair", "colors", "eyes"]);
  assert.deepEqual(picks[1].match, ["accessory"], "mood never counts");
  assert.equal(picks[2].match, undefined);
});

test("stage 1: picks claiming two or more shared features come first, stably", () => {
  const ordered = preferBroadMatches([
    { slug: "spheal", match: ["accessory"] },
    { slug: "riolu", match: ["hair", "colors"] },
    { slug: "pancham", match: ["eyes"] },
    { slug: "zorua", match: ["eyes", "face", "colors"] },
  ]);
  assert.deepEqual(ordered.map((p) => p.slug), ["riolu", "zorua", "spheal", "pancham"]);
  const untouched: { slug: string; match?: string[] }[] = [{ slug: "a" }, { slug: "b" }];
  assert.equal(preferBroadMatches(untouched), untouched, "no match lists → no-op");
});

test("traits: the slot object becomes a compact string, 'none' dropped", () => {
  const t = extractTraits({
    traits: { hair: "straight black bangs", eyes: "narrow", accessory: "none", colors: "dark hair, fair skin" },
  });
  assert.equal(t, "hair: straight black bangs; eyes: narrow; colors: dark hair, fair skin");
});

test("prompts: stage 1 demands two shared slots, stage 2 grades per feature", () => {
  assert.match(SYSTEM_PROMPT, /AT LEAST TWO/);
  assert.match(SYSTEM_PROMPT, /"match"/);
  for (const slot of MATCH_SLOTS) assert.ok(SYSTEM_PROMPT.includes(slot), slot);
  const rerank = buildRerankSystemPrompt(8);
  assert.match(rerank, /"overall", 0-10/);
  assert.match(rerank, /"scores"/);
  assert.match(rerank, /one striking shared feature/);
});

// ── Low-graded panels (observed in production, 2026-11-17) ──────────────────
import { RUBRIC_REJECT_BELOW, sanitizeReason } from "../lib/pokematch/judgeProtocol.ts";

test("reasons that deny any resemblance are withheld", () => {
  for (const r of [
    "얼굴이 보이지 않아 닮은 점을 찾을 수 없습니다.",
    "아무런 공통점도 없는 모습입니다.",
    "머리 모양이 닮지 않았어요",
  ]) {
    assert.equal(sanitizeReason(r), "", r);
  }
  assert.equal(sanitizeReason("파란 머리와 날카로운 눈매가 닮았어요"), "파란 머리와 날카로운 눈매가 닮았어요");
});

test("reject threshold: a near-zero grade is a miss, a modest match is not", () => {
  const miss = rubricScore({ hair: 1, eyes: 1, face: 0, colors: 0, accessory: null, overall: 2 });
  const modest = rubricScore({ hair: 2, eyes: 1, face: 1, colors: 0, accessory: null, overall: 4 });
  assert.ok(miss < RUBRIC_REJECT_BELOW, `miss ${miss}`);
  assert.ok(modest >= RUBRIC_REJECT_BELOW, `modest ${modest}`);
});
