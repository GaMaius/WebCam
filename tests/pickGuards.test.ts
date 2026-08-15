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
