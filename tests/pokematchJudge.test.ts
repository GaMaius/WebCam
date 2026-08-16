import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMAGE_BYTES,
  PICK_COUNT,
  buildMessages,
  buildUserPrompt,
  describeUnusable,
  extractJson,
  isUsableImage,
  normalizePicks,
  sanitizeCandidates,
  sanitizeReason,
  summarizeRateLimit,
  unresolvedNames,
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

// When the completion budget runs out mid-thought there's no closing tag, so
// the reasoning prose stays in `content`. Scanning that for braces can find a
// fragment that parses into something meaningless.
test("reasoning that was cut off mid-thought yields nothing, not a fragment", () => {
  const truncated = '<think>Let me consider. The face is {"picks":[{"name":"Pikachu"';
  assert.equal(extractJson(truncated), null);

  // A closed think block still gives up its answer.
  const closed = '<think>done thinking</think>{"picks":[{"name":"pikachu"}]}';
  assert.deepEqual(normalizePicks(extractJson(closed), candidates).map((p) => p.slug), ["pikachu"]);
});

// ⚠️ "judge_unusable" alone can't be acted on. An empty completion and a
// species named outside the pool are the same symptom with opposite fixes —
// raise the token budget, or change the pool — so the reason has to survive
// into ?debug rather than being inferred.
test("an unusable answer says WHY it was unusable", () => {
  // The thinking pass spent the whole budget: nothing was written.
  assert.equal(describeUnusable("", null), "empty_content");
  assert.equal(describeUnusable("   ", null), "empty_content");

  // Real observed failure: the whole 1400-token budget went into a think block
  // that never closed. Named separately because it needs the same fix as
  // empty_content (more budget), not a prompt change.
  assert.equal(
    describeUnusable("<think> The user wants me to identify 8 Pokemon that resemble", null),
    "thinking_never_finished"
  );

  // The model answered in prose. The snippet shows what it said instead.
  const prose = describeUnusable("죄송하지만 사람 얼굴은 판단할 수 없습니다.", null);
  assert.match(prose, /^unparsed:/);
  assert.ok(prose.includes("죄송"), "the snippet must carry the actual refusal");

  // Valid JSON, but every species named is outside the curated pool — raising
  // the token budget would do nothing for this one.
  assert.equal(
    describeUnusable('{"picks":[{"name":"Muk"},{"name":"Garbodor"}]}', {
      picks: [{ name: "Muk" }, { name: "Garbodor" }],
    }),
    "unresolved:Muk,Garbodor"
  );

  assert.equal(describeUnusable('{"picks":[]}', { picks: [] }), "no_picks_in_json");
});

test("the unusable summary can't smuggle anything through", () => {
  // The snippet is capped and flattened — a model that dumped its whole
  // reasoning must not paste it into a public response.
  const long = describeUnusable("가".repeat(500), null);
  assert.ok(long.length < 120, `snippet was ${long.length} chars`);
  assert.ok(!long.includes("\n"));

  // Names are stripped to plain text before being echoed back.
  const nasty = describeUnusable('{"picks":[{"name":"<script>x</script>"}]}', {
    picks: [{ name: "<script>x</script>" }],
  });
  assert.ok(!nasty.includes("<"), `leaked markup: ${nasty}`);
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

// The 291-name list cost ~1,050 tokens of a 6,070-token request against an 8K
// per-minute cap, and taught the model nothing it didn't know. It's gone from
// the prompt; the pool still gates the ANSWER via normalizePicks.
test("the prompt carries the face notes but not the candidate list", () => {
  const clean = sanitizeCandidates([
    { slug: "pikachu", nameKo: "피카츄", nameEn: "Pikachu" },
    { slug: "gengar", nameKo: "팬텀", nameEn: "Gengar" },
  ]);
  const prompt = buildUserPrompt("eye tilt 8deg (upturned/sharp)", clean);

  assert.ok(prompt.includes("eye tilt 8deg"), "face notes must survive");
  assert.ok(!prompt.includes("Pikachu"), "candidate names must not be spent on tokens");
  assert.ok(!prompt.includes("1."), "no numbered list any more");
  assert.ok(!prompt.includes("피카츄"), "Korean names were never sent");
  assert.ok(prompt.length < 900, `prompt ballooned to ${prompt.length} chars`);
});

test("a named species resolves only if the pool allows it", () => {
  const pool = sanitizeCandidates([
    { slug: "riolu", nameEn: "Riolu" },
    { slug: "zorua", nameEn: "Zorua" },
  ]);
  // Case, spacing and punctuation vary in what a model writes.
  const ok = normalizePicks(
    { picks: [{ name: "riolu", reason: "좋아요" }, { name: "  Zorua ", reason: "좋아요" }] },
    pool
  );
  assert.deepEqual(ok.map((p) => p.slug), ["riolu", "zorua"]);

  // A banned or unavailable species simply doesn't resolve — this is what
  // replaces the numbered list as the safety mechanism.
  const blocked = normalizePicks(
    { picks: [{ name: "Snorlax", reason: "x" }, { name: "Notapokemon", reason: "x" }] },
    pool
  );
  assert.deepEqual(blocked, [], "anything outside the pool must be dropped");
});

// ⚠️ Dropping a named species used to be silent, which made a short result
// impossible to read: eight picks arriving and one being shown looks exactly
// like the model returning one, and those need opposite fixes.
test("species the pool refuses are reported, not silently discarded", () => {
  const pool = sanitizeCandidates([
    { slug: "riolu", nameEn: "Riolu" },
    { slug: "zorua", nameEn: "Zorua" },
  ]);
  const raw = {
    picks: [
      { name: "Riolu", reason: "좋아요" },
      { name: "Snorlax", reason: "x" },
      { name: "Mightyena", reason: "x" },
      { name: "Notapokemon", reason: "x" },
    ],
  };

  assert.deepEqual(normalizePicks(raw, pool).map((p) => p.slug), ["riolu"]);
  assert.deepEqual(unresolvedNames(raw, pool), ["Snorlax", "Mightyena", "Notapokemon"]);

  // Nothing to report when everything resolved.
  assert.deepEqual(unresolvedNames({ picks: [{ name: "Zorua" }] }, pool), []);
});

test("the dropped-name list can't smuggle markup or run long", () => {
  const pool = sanitizeCandidates([{ slug: "riolu", nameEn: "Riolu" }]);
  const names = unresolvedNames(
    { picks: Array.from({ length: 30 }, () => ({ name: "<b>Ghost</b>" })) },
    pool
  );
  assert.ok(names.length <= 12, `reported ${names.length} names`);
  assert.ok(!names.some((n) => n.includes("<")), `leaked markup: ${names.join(",")}`);
});

test("the prompt still works with no face measurements at all", () => {
  const clean = sanitizeCandidates([{ slug: "pikachu", nameEn: "Pikachu" }]);
  const prompt = buildUserPrompt("", clean);
  assert.ok(prompt.includes("Name the"), "the instruction must survive");
  assert.ok(!prompt.includes("Measured face notes"), "empty description should not print a header");
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

// These use sentences the model actually produced. The input is somebody's
// face, so a withheld reason beats a rude one.
test("a reason that judges the person's appearance is withheld", () => {
  assert.equal(sanitizeReason("통통한 얼굴형과 진지한 눈매가 잘 어울립니다"), "");
  assert.equal(sanitizeReason("약간 어색해 보이는 표정이 잘 통합니다"), "");
  assert.equal(sanitizeReason("넓은 코와 입술이 특징을 잘 살립니다"), "");
});

test("a species name leaking into the reason is withheld, since the UI shows a different one", () => {
  // Real output: this appeared under a row labelled 고라파덕.
  assert.equal(sanitizeReason("넓게 열린 눈과 긴 이마가 싸이duck와 통합니다"), "");
  assert.equal(sanitizeReason("Marill의 귀여운 인상과 잘 어울립니다"), "");
});

// ⚠️ The list was literal, so the polite version of the same remark walked
// straight past it. Real output on a face measured at 1.35 length-to-width:
// "폭신한 볼륨과 편안한 표정이 잘 어울립니다".
test("a polite way of calling someone's face full is withheld too", () => {
  assert.equal(sanitizeReason("폭신한 볼륨과 편안한 표정이 잘 어울립니다"), "");
  assert.equal(sanitizeReason("귀여운 눈매와 폭신한 볼륨이 잘 어울립니다"), "");
  assert.equal(sanitizeReason("푸근한 얼굴이 편안한 인상을 줍니다"), "");
  assert.equal(sanitizeReason("볼륨감 있는 얼굴이 잘 어울립니다"), "");
});

test("full lips stay sayable — the pipeline measures them as a neutral feature", () => {
  const ok = "볼륨감 있는 입술이 또렷한 인상을 줍니다";
  assert.equal(sanitizeReason(ok), ok);
});

test("a good reason survives intact", () => {
  const good = "둥근 안경과 부드러운 눈매가 잘 어울립니다";
  assert.equal(sanitizeReason(good), good);
  assert.equal(sanitizeReason("  눈꼬리가 올라가 시원한 인상이에요  "), "눈꼬리가 올라가 시원한 인상이에요");
});

test("picks survive a rejected reason — the species still shows, just without a sentence", () => {
  const picks = normalizePicks({ picks: [{ n: 1, reason: "통통한 얼굴이 닮았습니다" }] }, candidates);
  assert.equal(picks.length, 1, "a bad sentence must not cost the user their result");
  assert.equal(picks[0].slug, "pikachu");
  assert.equal(picks[0].reason, "");
});

test("an explicit retry-after header wins over the prose, and odd bodies still summarize", () => {
  assert.match(summarizeRateLimit("on requests per day (RPD): ... try again in 9s", "60"), /retry_after=60/);
  assert.equal(summarizeRateLimit("something unparseable", null), "unspecified");
});

// A per-minute cap and a daily budget both arrive as 429 but need opposite
// advice — one lifts in seconds, the other not until tomorrow — so the limit
// name has to survive into the summary the client reads.
test("the summary says whether the limit was per-minute or per-day", () => {
  const perDay = summarizeRateLimit(
    "Rate limit reached ... on tokens per day (TPD): Limit 200000, Used 200000, Requested 3600.",
    null
  );
  assert.match(perDay, /_per_day/, "client keys the 'come back tomorrow' copy off this");

  const perMinute = summarizeRateLimit(
    "Rate limit reached ... on tokens per minute (TPM): Limit 8000, Used 6000, Requested 3600. Please try again in 12s.",
    null
  );
  assert.doesNotMatch(perMinute, /_per_day/);
  assert.match(perMinute, /_per_minute/);
});
