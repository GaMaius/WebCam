import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMAGE_BYTES,
  PICK_COUNT,
  buildMessages,
  buildUserPrompt,
  extractJson,
  isUsableImage,
  normalizePicks,
  sanitizeCandidates,
  summarizeRateLimit,
} from "../lib/pokematch/judgeProtocol.ts";

// The judge is an LLM, so its output is untrusted input. Everything the prompt
// asks for is re-checked here; these tests pin that, not the model's manners.

// Candidates are addressed by 1-based number in the order given to
// buildUserPrompt — normalizePicks must resolve against that same array.
const candidates = sanitizeCandidates(
  ["pikachu", "gengar", "lucario", "gardevoir", "eevee"].map((slug) => ({ slug }))
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
    { slug: "muk_alola", nameEn: "Muk" },
  ];
  const clean = sanitizeCandidates(raw);
  assert.deepEqual(clean.map((c) => c.slug), ["pikachu", "muk_alola"]);
  assert.equal(clean[1].nameEn, "Muk");
});

test("the prompt numbers candidates by English name and keeps the face notes", () => {
  const clean = sanitizeCandidates([
    { slug: "pikachu", nameKo: "피카츄", nameEn: "Pikachu" },
    { slug: "gengar", nameKo: "팬텀", nameEn: "Gengar" },
  ]);
  const prompt = buildUserPrompt("얼굴형: 계란형", clean);

  assert.ok(prompt.includes("1.Pikachu"));
  assert.ok(prompt.includes("2.Gengar"));
  assert.ok(prompt.includes("얼굴형: 계란형"));
  // The Korean name is display-side only; the model works from English.
  assert.ok(!prompt.includes("피카츄"), "Korean name should not be spent on tokens");
});

test("the prompt still works with no face measurements at all", () => {
  const clean = sanitizeCandidates([{ slug: "pikachu", nameEn: "Pikachu" }]);
  const prompt = buildUserPrompt("", clean);
  assert.ok(prompt.includes("1.Pikachu"));
  assert.ok(!prompt.includes("참고용 얼굴 측정값"), "empty description should not print a header");
});

test("the image is the last message part, after the instructions", () => {
  const clean = sanitizeCandidates([{ slug: "pikachu", nameEn: "Pikachu" }]);
  const messages = buildMessages("얼굴형: 계란형", clean, "data:image/jpeg;base64,AAAA");
  assert.equal(messages[0].role, "system");
  const parts = messages[1].content as { type: string }[];
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "image_url");
});

test("only well-formed, size-capped image data URLs are accepted", () => {
  assert.ok(isUsableImage("data:image/jpeg;base64,/9j/4AAQSkZJRg=="));
  assert.ok(isUsableImage("data:image/png;base64,iVBORw0KGgo="));
  // A remote URL would make the API fetch an arbitrary host on our behalf.
  assert.equal(isUsableImage("https://example.com/face.jpg"), false);
  assert.equal(isUsableImage("data:text/html;base64,PHNjcmlwdD4="), false);
  assert.equal(isUsableImage("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.equal(isUsableImage(""), false);
  assert.equal(isUsableImage(null), false);
  assert.equal(
    isUsableImage("data:image/jpeg;base64," + "A".repeat(MAX_IMAGE_BYTES)),
    false,
    "oversized images must be refused before they reach a paid API"
  );
});

test("an over-long description is truncated before it reaches the prompt", () => {
  const prompt = buildUserPrompt("가".repeat(9000), sanitizeCandidates([{ slug: "pikachu" }]));
  assert.ok(prompt.length < 6000, `prompt was ${prompt.length} chars`);
});

// A bare 429 can mean a per-minute burst (wait a moment) or a spent daily
// budget (done until tomorrow). These use Groq's actual message wording.
test("a per-minute rate limit is distinguishable from a daily one", () => {
  const perMinute = summarizeRateLimit(
    '{"error":{"message":"Rate limit reached for model `qwen/qwen3.6-27b` in organization `org_01abc` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7600, Requested 3100. Please try again in 5.2s."}}',
    null
  );
  assert.match(perMinute, /tokens_per_minute/);
  assert.match(perMinute, /limit=8000,used=7600,requested=3100/);
  assert.match(perMinute, /retry_after=5\.2s/);

  const perDay = summarizeRateLimit(
    '{"error":{"message":"Rate limit reached for model `qwen/qwen3.6-27b` in organization `org_01abc` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 200000, Requested 3100."}}',
    null
  );
  assert.match(perDay, /tokens_per_day/);
});

test("the organization id never leaks into the summary", () => {
  const summary = summarizeRateLimit(
    "Rate limit reached for model `x` in organization `org_01secret` on tokens per day (TPD): Limit 1, Used 1, Requested 1.",
    null
  );
  assert.ok(!summary.includes("org_01secret"), `leaked: ${summary}`);
});

test("an explicit retry-after header wins over the prose, and odd bodies still summarize", () => {
  assert.match(summarizeRateLimit("on requests per day (RPD): ... try again in 9s", "60"), /retry_after=60/);
  assert.equal(summarizeRateLimit("something unparseable", null), "unspecified");
});
