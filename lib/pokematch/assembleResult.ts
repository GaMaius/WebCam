// Which five species the result screen shows, and in what order.
//
// Pure and import-light (judgeProtocol only) so the decision can be replayed
// from a real ?debug dump under `node --test` — see tests/pokematchAssemble.test.ts.

import { hasVisibleFeature } from "./judgeProtocol.ts";

export interface AssemblyItem {
  slug: string;
  reason?: string;
}

export interface AssemblyInput<T extends AssemblyItem> {
  /** The judge's picks after pickGuards, in judge order — which is rubric
   * order when the rerank graded them. */
  modelPicks: T[];
  /** The local embedding ranker, best first. Unverified: it never looked at
   * the face the way the judge did. */
  local: T[];
  /** The curated pool (household-name species). */
  familiar: Set<string>;
  /** True when the visual rerank graded every pick (rubric scores present). */
  graded: boolean;
  count?: number;
}

/**
 * ⚠️⚠️ TWO MODES, AND THE GRADED ONE MUST NOT USE THE FAMILIAR TIERS.
 *
 * GRADED (the rerank compared the face with each pick's artwork and scored
 * it): the rubric order IS the verdict. Model picks go first, best score
 * first; the local ranker only fills slots the model left empty.
 *
 *   Why (2026-11-17, real scan, user: "이게 맞냐?"): the rubric ranked
 *   Gothita 13 and Espurr 12 at the top — neither is in the curated pool —
 *   and scored the three pool members (Umbreon, Lilligant, Grimmsnarl) as
 *   misses. The familiar-first tiers then had no familiar model pick to show,
 *   so tier 2, "local ranker restricted to familiar species", filled all five
 *   slots: Lickitung, Exeggcute, Maushold, Ambipom, Tinkaton. Not ONE of the
 *   judge's picks reached the screen, and the result was the embedding
 *   ranker's guesses for a face it measurably can't read (see the CLAUDE.md
 *   note on why embedding similarity is not human similarity). A verified
 *   judgement must never lose to an unverified guess.
 *
 * UNGRADED (the rerank failed or didn't run): the original four tiers, which
 * exist because without verification the curated pool was doing real quality
 * work (it kept Crobat and Dunsparce off the screen):
 *   1. model picks in the pool  2. local picks in the pool
 *   3. other model picks         4. local, unrestricted
 * Within model tiers, picks whose reason names a visible feature go first.
 */
export function assembleDisplayed<T extends AssemblyItem>(input: AssemblyInput<T>): T[] {
  const { modelPicks, local, familiar, graded, count = 5 } = input;

  const tiers: T[][] = graded
    ? [modelPicks, local]
    : (() => {
        const grounded = (m: T) => Boolean(m.reason && hasVisibleFeature(m.reason));
        const groundedFirst = (list: T[]) => [
          ...list.filter(grounded),
          ...list.filter((m) => !grounded(m)),
        ];
        return [
          groundedFirst(modelPicks.filter((m) => familiar.has(m.slug))),
          local.filter((m) => familiar.has(m.slug)),
          groundedFirst(modelPicks.filter((m) => !familiar.has(m.slug))),
          local,
        ];
      })();

  const have = new Set<string>();
  const out: T[] = [];
  for (const tier of tiers) {
    for (const m of tier) {
      if (out.length >= count || have.has(m.slug)) continue;
      have.add(m.slug);
      out.push(m);
    }
  }
  return out;
}
