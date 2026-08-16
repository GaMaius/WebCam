import test from "node:test";
import assert from "node:assert/strict";
import { applyPickGuards, reasonContradictsFace } from "../lib/pokematch/pickGuards.ts";
import type { FaceFeatures } from "../lib/pokematch/faceFeatures.ts";
import type { PokedexEntry } from "../lib/pokematch/matcher.ts";

// These guards exist because every face-specific fix made things worse. What
// they check is not "is this the right Pokemon" — nothing here can know that —
// but "is this pick justified for the face actually measured", which is a
// question that means the same thing for everybody.

/** A long face with upturned eyes and dark hair — the measurements from a real
 * scan whose judged reason nonetheless said "얼굴이 둥글고". */
const LONG_FACE: FaceFeatures = {
  lengthToWidth: 1.21,
  eyeSlant: 8.6,
  hairBrightness: 0.18,
} as FaceFeatures;

const ROUND_FACE: FaceFeatures = {
  lengthToWidth: 1.05,
  eyeSlant: -6,
  hairBrightness: 0.7,
} as FaceFeatures;

test("a reason is dropped when this face's measurements say it is false", () => {
  // The exact sentence that prompted these guards.
  assert.equal(reasonContradictsFace("얼굴이 둥글고 눈이 커서 잘 어울립니다", LONG_FACE), true);
  assert.equal(reasonContradictsFace("갸름한 얼굴선이 잘 맞습니다", ROUND_FACE), true);
  assert.equal(reasonContradictsFace("검은 머리가 잘 어울립니다", ROUND_FACE), true);
  assert.equal(reasonContradictsFace("밝은 머리색이 잘 어울립니다", LONG_FACE), true);
  assert.equal(reasonContradictsFace("처진 눈매가 순한 인상을 줍니다", LONG_FACE), true);
});

test("the same sentences are fine on a face they actually describe", () => {
  assert.equal(reasonContradictsFace("얼굴이 둥글고 눈이 커서 잘 어울립니다", ROUND_FACE), false);
  assert.equal(reasonContradictsFace("갸름한 얼굴선이 잘 맞습니다", LONG_FACE), false);
  assert.equal(reasonContradictsFace("검은 머리가 잘 어울립니다", LONG_FACE), false);
  assert.equal(reasonContradictsFace("올라간 눈매가 시원한 인상입니다", LONG_FACE), false);
});

test("a reason that claims nothing measurable is left alone", () => {
  // Vague and false deserve different treatment, and only one is checkable.
  assert.equal(reasonContradictsFace("전체적인 분위기가 잘 어울립니다", LONG_FACE), false);
  assert.equal(reasonContradictsFace("", LONG_FACE), false);
});

test("with no measurements nothing is contradicted", () => {
  assert.equal(reasonContradictsFace("얼굴이 둥글고 잘 어울립니다", null), false);
});

const pokedex = {
  a: { shape: "upright" },
  b: { shape: "upright" },
  c: { shape: "upright" },
  d: { shape: "quadruped" },
  e: { shape: "blob" },
  f: { shape: "wings" },
} as unknown as Record<string, PokedexEntry>;

const picks = (...slugs: string[]) => slugs.map((slug) => ({ slug, reason: "좋은 인상입니다" }));

test("one silhouette cannot take over the set when there are spares to use", () => {
  // The real shape: the judge is asked for 8 and 5 are shown, so the cap has
  // somewhere to fall back to. Three uprights lead, and must not all survive.
  const out = applyPickGuards(picks("a", "b", "c", "d", "e", "f"), pokedex, null, 5);
  const shapes = out.map((p) => pokedex[p.slug].shape);
  assert.equal(out.length, 5);
  assert.ok(
    shapes.filter((s) => s === "upright").length <= 2,
    `three uprights survived: ${shapes.join(",")}`
  );
});

test("the cap yields when nothing else is available", () => {
  // Better a repetitive five than a short four. Only uprights exist here.
  const out = applyPickGuards(picks("a", "b", "c"), pokedex, null, 3);
  assert.deepEqual(out.map((p) => p.slug), ["a", "b", "c"]);
});

test("the model's ordering is preserved among the picks that survive", () => {
  const out = applyPickGuards(picks("a", "d", "e"), pokedex, null, 5);
  assert.deepEqual(out.map((p) => p.slug), ["a", "d", "e"]);
});

test("a short list is filled rather than returned incomplete", () => {
  // Only uprights available: the cap must yield rather than hand back two.
  const out = applyPickGuards(picks("a", "b", "c"), pokedex, null, 3);
  assert.equal(out.length, 3, "an incomplete result is worse than a repetitive one");
});

// ⚠️ THE REAL RUN THIS ENCODES. With the answer gated on the 294-species pool,
// four of the judge's eight picks were deleted outright (Emolga, Braixen, Aipom
// among them). Widening the gate fixed that and immediately showed what the
// narrow one had also been doing: the next run led with Crobat, then Dunsparce,
// Skuntank, Bonsly — a bat, a drill-snake, a skunk. Only Zorua, Absol and
// Vulpix read as a lookalike, and those three were exactly the pool members.
test("household names lead, and the obscure ones are demoted rather than deleted", () => {
  const familiar = new Set(["d", "e"]);
  const out = applyPickGuards(picks("a", "b", "c", "d", "e", "f"), pokedex, null, 5, familiar);

  assert.deepEqual(out.slice(0, 2).map((p) => p.slug), ["d", "e"], "familiar picks lead");
  assert.equal(out.length, 5, "the rest still fill the set — this is a preference, not a gate");
  assert.ok(out.some((p) => !familiar.has(p.slug)), "an unfamiliar species must still be reachable");
});

// ⚠️ Replayed from the real run. Zorua, Absol and Vulpix are all `quadruped`,
// so the silhouette cap pushed Vulpix out and gave its slot to Crobat — a bat.
// Repetitive beats wrong, so a capped familiar pick outranks an uncapped
// unfamiliar one.
test("the silhouette cap yields to familiarity rather than seating an oddity", () => {
  const dex = {
    zorua: { shape: "quadruped" },
    absol: { shape: "quadruped" },
    vulpix: { shape: "quadruped" },
    crobat: { shape: "bug-wings" },
    dunsparce: { shape: "squiggle" },
  } as unknown as Record<string, PokedexEntry>;
  const out = applyPickGuards(
    picks("crobat", "dunsparce", "zorua", "absol", "vulpix"),
    dex,
    null,
    5,
    new Set(["zorua", "absol", "vulpix"])
  );
  assert.deepEqual(out.slice(0, 3).map((p) => p.slug), ["zorua", "absol", "vulpix"]);
});

test("preference never shortens the result when nothing is familiar", () => {
  const out = applyPickGuards(picks("a", "d", "e"), pokedex, null, 5, new Set(["zzz"]));
  assert.deepEqual(out.map((p) => p.slug), ["a", "d", "e"], "order is untouched when none match");
});

test("the model's order survives inside each familiarity group", () => {
  const out = applyPickGuards(picks("a", "d", "b", "e"), pokedex, null, 4, new Set(["d", "e"]));
  // d before e (model order), then a before b (model order).
  assert.deepEqual(out.map((p) => p.slug), ["d", "e", "a", "b"]);
});

test("a contradicted reason is blanked but never costs the user the pick", () => {
  const out = applyPickGuards(
    [{ slug: "a", reason: "얼굴이 둥글고 잘 어울립니다" }],
    pokedex,
    LONG_FACE,
    5
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].slug, "a");
  assert.equal(out[0].reason, "");
});
