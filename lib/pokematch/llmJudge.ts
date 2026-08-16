// Client side of the PokéMatch judge. Talks to /api/pokematch/judge, which
// proxies Groq (the key stays server-side). Everything here degrades quietly:
// any failure returns null so the caller can fall back to the local z-score
// ranking rather than showing the user an error for a fun feature.
//
// ⚠️ This sends the cropped face IMAGE to a third-party API. The judge is a
// vision model — that's the feature. The intro modal says so; keep it saying so.

import { zToPercent, type PokematchCandidate, type PokematchMatch, type PokedexEntry } from "./matcher";
import { PICK_COUNT } from "./judgeProtocol";
import { applyPickGuards } from "./pickGuards";
import { buildCuratedPool } from "./curatedPool";
import type { FaceFeatures } from "./faceFeatures";

export interface JudgePick {
  slug: string;
  reason: string;
}

export interface JudgeResult {
  picks: JudgePick[];
  model: string;
  /** Which configured provider answered ("primary"/"secondary"). Surfaced in
   * ?debug so a silent failover to the backup is visible rather than looking
   * like the primary simply behaved differently. */
  provider?: string;
  /** The provider's own token accounting for this call ("prompt=… completion=…").
   * Measured, unlike every character-count estimate that preceded it. */
  usage?: string;
  /** Species the model named that the curated pool refused, comma-separated.
   * Without it a short result can't be read: eight picks arriving and one being
   * shown is indistinguishable from the model returning one, and those need
   * opposite fixes. */
  dropped?: string;
  /** Set only when picks is empty — why the judge didn't run, for the
   * ?debug panel. The route already categorizes its own failures
   * (judge_unconfigured / rate_limited_local — our own IP cap, never reached
   * Groq / rate_limited_upstream — Groq's own quota / judge_unavailable /
   * judge_unusable); this just carries that (or an http/network reason) back
   * so a silent fallback to local ranking isn't a dead end to diagnose. */
  reason?: string;
  /** Seconds to wait, when the judge was refused by a rate limit that will
   * lift on its own. Drives a "try again in Ns" message — the local fallback
   * is visibly worse, so telling the user it's temporary beats letting them
   * conclude the feature is broken. */
  retryAfterSec?: number;
  /** True when the judge was refused for capacity rather than broken. The UI
   * says so plainly, because a rate-limited result and a failed one look
   * identical on screen but only one is worth retrying. */
  rateLimited?: boolean;
  /** True when the limit that tripped was a DAILY one rather than per-minute.
   * The two need opposite advice: a per-minute cap lifts in seconds, a daily
   * budget does not lift today at all, and telling someone to wait a moment
   * for something that won't come back until tomorrow is worse than saying
   * nothing. */
  dailyLimit?: boolean;
}

/** The wait Groq asked for, when it's short enough to be worth offering as a
 * retry rather than reading as "come back tomorrow". */
function parseRetryAfter(detail: string | undefined): number | undefined {
  const raw = detail ? /retry_after=([\d.]+)/.exec(detail)?.[1] : undefined;
  const sec = raw ? Number(raw) : NaN;
  return Number.isFinite(sec) && sec > 0 && sec <= 120 ? Math.ceil(sec) : undefined;
}

/** Whether the tripped limit was a per-DAY one. summarizeRateLimit emits the
 * limit name verbatim ("tokens_per_day", "requests_per_day"). */
function isDailyLimit(detail: string | undefined): boolean {
  return detail ? /_per_day/.test(detail) : false;
}

const JUDGE_TIMEOUT_MS = 50_000;

export async function judgeCandidates(
  imageDataUrl: string,
  description: string,
  candidates: PokematchCandidate[]
): Promise<JudgeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/pokematch/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        image: imageDataUrl,
        description,
        // Only what the prompt actually prints: the English name the model
        // knows the species by, and the slug we resolve the answer back to.
        candidates: candidates.map((c) => ({
          slug: c.slug,
          nameEn: c.entry?.nameEn ?? undefined,
        })),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { error?: string; detail?: string; keys?: string }
        | null;
      const reason =
        `http_${res.status}` +
        (body?.error ? `:${body.error}` : "") +
        // Present on upstream 429s: names the limit that tripped, so a burst
        // against the per-minute cap is distinguishable from a spent daily one.
        (body?.detail ? ` (${body.detail})` : "") +
        // Per-key outcome. A single scan must fit inside ONE key's budget, so
        // a failure with two keys configured means both refused — and this
        // shows whether the second was even reached.
        (body?.keys ? `
  keys: ${body.keys}` : "");
      return {
        picks: [],
        model: "",
        reason,
        retryAfterSec: parseRetryAfter(body?.detail),
        rateLimited: res.status === 429,
        dailyLimit: res.status === 429 && isDailyLimit(body?.detail),
      };
    }
    const data = (await res.json()) as Partial<JudgeResult>;
    if (!Array.isArray(data.picks) || data.picks.length === 0) {
      return { picks: [], model: "", reason: "empty_picks" };
    }
    return {
      picks: data.picks,
      model: typeof data.model === "string" ? data.model : "",
      provider: typeof data.provider === "string" ? data.provider : undefined,
      usage: typeof data.usage === "string" ? data.usage : undefined,
      dropped: typeof data.dropped === "string" ? data.dropped : undefined,
    };
  } catch (err) {
    const reason = err instanceof DOMException && err.name === "AbortError" ? "timeout" : "network_error";
    return { picks: [], model: "", reason };
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
/**
 * Drops a reason that names a species.
 *
 * The route already refuses latin script, which caught English names bleeding
 * through ("싸이duck" under a row titled 고라파덕). It cannot catch a Korean
 * one, because the server has no pokedex — but this does, so the check belongs
 * here. Observed slipping past the first filter: "칼라콘의 매혹적인 눈빛".
 *
 * A name the model invents outright is still only prevented by the prompt;
 * there's nothing to match it against. That's a narrower gap than it looks,
 * since the model mostly reaches for names it actually knows.
 */
function withoutSpeciesNames(
  reason: string | undefined,
  pokedex: Record<string, PokedexEntry>
): string | undefined {
  if (!reason) return undefined;
  for (const entry of Object.values(pokedex)) {
    const ko = entry?.nameKo;
    if (ko && ko.length >= 2 && reason.includes(ko)) return undefined;
  }
  return reason;
}

export function picksToMatches(
  picks: JudgePick[],
  pokedex: Record<string, PokedexEntry>,
  candidates: PokematchCandidate[],
  features: FaceFeatures | null = null
): PokematchMatch[] {
  // The judge is asked for more picks than are shown, so the surplus can be
  // spent here on quality rather than displayed as-is. See pickGuards: a
  // reason that contradicts this face's own measurements is withheld, and one
  // silhouette can't take over the whole set.
  //
  // `familiar` is the curated pool, which stopped being a GATE on the answer
  // (that deleted Emolga, Braixen and Aipom out of one run) and is a preference
  // instead: household names sort ahead, everything else still gets shown when
  // there aren't five of them. Computed from the candidates actually sent, so
  // it can't reference a species this scan couldn't render.
  const familiar = new Set(buildCuratedPool(pokedex, candidates.map((c) => c.slug)));
  const guarded = applyPickGuards(
    picks.map((p) => ({ slug: p.slug, reason: p.reason ?? "" })),
    pokedex,
    features,
    PICK_COUNT,
    familiar
  );
  picks = guarded;

  const zBySlug = new Map(candidates.map((c) => [c.slug, c.z]));

  const zs = candidates.map((c) => c.z);
  const mean = zs.reduce((a, b) => a + b, 0) / (zs.length || 1);
  const std = Math.sqrt(zs.reduce((a, b) => a + (b - mean) ** 2, 0) / (zs.length || 1)) || 1;
  const standardized = (slug: string) => ((zBySlug.get(slug) ?? mean) - mean) / std;

  const topSz = picks.length ? standardized(picks[0].slug) : 0;
  const matches = picks.map((p) => ({
    slug: p.slug,
    entry: pokedex[p.slug] ?? null,
    z: zBySlug.get(p.slug) ?? 0,
    percent: zToPercent(standardized(p.slug), topSz),
    reason: withoutSpeciesNames(p.reason || undefined, pokedex),
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
