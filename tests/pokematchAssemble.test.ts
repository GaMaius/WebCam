// Replays the 2026-11-17 scan the user flagged with "이게 맞냐?": the rubric
// ranked Gothita and Espurr on top, yet the screen showed Lickitung,
// Exeggcute, Maushold, Ambipom and Tinkaton — none of the judge's picks.
import test from "node:test";
import assert from "node:assert/strict";
import { assembleDisplayed } from "../lib/pokematch/assembleResult.ts";

const pick = (slug: string, reason = "") => ({ slug, reason });

// The judge's eight, in the rubric's order from that scan's ?debug dump.
const graded = [
  pick("gothita", "둥근 이마와 큰 눈, 긴 머리 형태가 닮았습니다."),
  pick("espurr", "털결이 있는 머리 모양과 동그란 얼굴이 닮았습니다."),
  pick("munna", "연분홍 피부색과 둥근 얼굴 윤곽이 유사합니다."),
  pick("pansage", "둥근 얼굴 형태와 큰 눈만 공통점입니다."),
  pick("lilligant", "둥근 얼굴과 긴 머리 형태가 닮았습니다."),
  pick("cursola", "흰색 머리칼과 둥근 얼굴이 약간 닮았습니다."),
  pick("grimmsnarl", "두꺼운 눈썹 모양만 아주 약간 닮았습니다."),
  pick("umbreon", "긴 머리칼과 날카로운 눈 모양이 닮았습니다."),
];
// The local embedding ranker's output that ended up on screen.
const local = ["lickitung", "exeggcute", "maushold", "ambipom", "tinkaton"].map((s) => pick(s));
// Curated pool membership for these species (gen 1 + EXTRA_FAMOUS).
const familiar = new Set([
  "lilligant", "grimmsnarl", "umbreon", "lickitung", "exeggcute", "maushold", "ambipom", "tinkaton",
]);

test("graded: the rubric's top picks are what the screen shows", () => {
  const shown = assembleDisplayed({ modelPicks: graded, local, familiar, graded: true });
  assert.deepEqual(
    shown.map((m) => m.slug),
    ["gothita", "espurr", "munna", "pansage", "lilligant"]
  );
});

test("graded: no local species appears while the judge has picks to show", () => {
  const shown = assembleDisplayed({ modelPicks: graded, local, familiar, graded: true });
  assert.ok(shown.every((m) => !local.some((l) => l.slug === m.slug)));
});

test("graded: local only fills slots the judge left empty", () => {
  const shown = assembleDisplayed({ modelPicks: graded.slice(0, 3), local, familiar, graded: true });
  assert.deepEqual(
    shown.map((m) => m.slug),
    ["gothita", "espurr", "munna", "lickitung", "exeggcute"]
  );
});

test("ungraded: the familiar tiers still apply when nothing verified the picks", () => {
  const shown = assembleDisplayed({ modelPicks: graded, local, familiar, graded: false });
  // Familiar model picks first (feature-grounded ones within that tier first),
  // then familiar local picks.
  assert.deepEqual(
    shown.map((m) => m.slug),
    ["lilligant", "grimmsnarl", "umbreon", "lickitung", "exeggcute"]
  );
});

test("no duplicates and never more than five", () => {
  const shown = assembleDisplayed({
    modelPicks: [...graded, graded[0]],
    local: [...local, pick("gothita")],
    familiar,
    graded: true,
  });
  assert.equal(shown.length, 5);
  assert.equal(new Set(shown.map((m) => m.slug)).size, 5);
});
