// Client side of the PokéMatch judge. Talks to /api/pokematch/judge, which
// proxies Groq (the key stays server-side). Everything here degrades quietly:
// any failure returns null so the caller can fall back to the local z-score
// ranking rather than showing the user an error for a fun feature.

import type { PokematchCandidate, PokematchMatch, PokedexEntry } from "./matcher";
import { isCurated, lookFor } from "./curatedPool";

export interface JudgePick {
  slug: string;
  percent: number;
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

/** Maps the judge's picks back onto the pokedex so the UI and result card
 * render them exactly like locally-ranked matches. */
export function picksToMatches(
  picks: JudgePick[],
  pokedex: Record<string, PokedexEntry>,
  candidates: PokematchCandidate[]
): PokematchMatch[] {
  const zBySlug = new Map(candidates.map((c) => [c.slug, c.z]));
  return picks.map((p) => ({
    slug: p.slug,
    entry: pokedex[p.slug] ?? null,
    z: zBySlug.get(p.slug) ?? 0,
    percent: p.percent,
    reason: p.reason || undefined,
  }));
}
