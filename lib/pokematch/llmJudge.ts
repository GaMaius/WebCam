// Client side of the PokéMatch judge. Talks to /api/pokematch/judge, which
// proxies Groq (the key stays server-side). Everything here degrades quietly:
// any failure returns null so the caller can fall back to the local z-score
// ranking rather than showing the user an error for a fun feature.

import { zToPercent, type PokematchCandidate, type PokematchMatch, type PokedexEntry } from "./matcher";
import { isCurated, lookFor } from "./curatedPool";

export interface JudgePick {
  slug: string;
  reason: string;
}

export interface JudgeResult {
  picks: JudgePick[];
  model: string;
}

const JUDGE_TIMEOUT_MS = 28_000;

export async function judgeCandidates(
  description: string,
  candidates: PokematchCandidate[]
): Promise<JudgeResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/pokematch/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        description,
        candidates: candidates.map((c) => ({
          slug: c.slug,
          nameKo: c.entry?.nameKo ?? undefined,
          nameEn: c.entry?.nameEn ?? undefined,
          types: c.entry?.typesKo ?? c.entry?.typesEn,
          color: c.entry?.color ?? null,
          shape: c.entry?.shape ?? null,
          z: c.z,
          look: lookFor(c.slug),
          curated: isCurated(c.slug),
        })),
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<JudgeResult>;
    if (!Array.isArray(data.picks) || data.picks.length === 0) return null;
    return { picks: data.picks, model: typeof data.model === "string" ? data.model : "" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps the judge's picks back onto the pokedex so the UI and result card
 * render them exactly like locally-ranked matches.
 *
 * The displayed "닮은 정도 %" is computed HERE, not asked of the model: it
 * comes from each pick's embedding z standardized across the candidate set,
 * the same mapping the local ranker uses. That keeps the number tied to a real
 * measurement, costs no tokens, and removes a rule the model used to break
 * (it regularly returned ties or an ascending list). Rank order still comes
 * from the model, so the sequence is enforced as strictly descending.
 */
export function picksToMatches(
  picks: JudgePick[],
  pokedex: Record<string, PokedexEntry>,
  candidates: PokematchCandidate[]
): PokematchMatch[] {
  const zBySlug = new Map(candidates.map((c) => [c.slug, c.z]));

  const zs = candidates.map((c) => c.z);
  const mean = zs.reduce((a, b) => a + b, 0) / (zs.length || 1);
  const std =
    Math.sqrt(zs.reduce((a, b) => a + (b - mean) ** 2, 0) / (zs.length || 1)) || 1;
  const standardized = (slug: string) => ((zBySlug.get(slug) ?? mean) - mean) / std;

  const topSz = picks.length ? standardized(picks[0].slug) : 0;
  const matches = picks.map((p) => ({
    slug: p.slug,
    entry: pokedex[p.slug] ?? null,
    z: zBySlug.get(p.slug) ?? 0,
    percent: zToPercent(standardized(p.slug), topSz),
    reason: p.reason || undefined,
  }));

  // The judge's ORDER is the ranking; z only sets the magnitude. A later pick
  // showing a higher percent than an earlier one would read as a bug.
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].percent >= matches[i - 1].percent) {
      matches[i].percent = Math.max(50, matches[i - 1].percent - 2);
    }
  }
  return matches;
}
