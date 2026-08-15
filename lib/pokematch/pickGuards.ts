// Face-independent quality guards on what the judge sends back.
//
// Every earlier attempt to improve results encoded something about ONE face —
// a list of mascots to ban, a shortlist cut by embedding score — and each made
// things worse for the same reason: it hard-coded an answer instead of a
// standard. These checks encode a standard. They ask whether a pick is
// justified FOR THE FACE IN FRONT OF THEM, using that face's own measurements,
// so they behave the same for a person whose face nothing here anticipated.
//
// Two failure modes are observable without knowing whose face it is:
//
//   1. The reason contradicts the measurements. A judged run described a face
//      measured at 1.21 length-to-width — clearly elongated — as "얼굴이
//      둥글고". A claim the pipeline can verify as false should not be shown
//      to the person it is false about.
//
//   2. The five picks are one pick five times. The model reworded a single
//      observation ("big round eyes") across all five, and filled them with
//      species of the same silhouette. The prompt forbids both; the model does
//      it anyway, so it is enforced here.
//
// The judge is asked for more picks than are displayed, which is what makes
// dropping any of them affordable.

import type { FaceFeatures } from "./faceFeatures";
import type { PokedexEntry } from "./matcher";

/**
 * Length-to-width bounds for calling a face round or long.
 *
 * Taken from the app's own classifier rather than invented: classifyFaceShape
 * in lib/faceShape.ts treats below 1.15 as round. A claim of roundness is only
 * contradicted past 1.20, which leaves the 1.15-1.20 band unjudged so a
 * borderline face never loses a good sentence.
 *
 * ⚠️ These were first set at 1.22/1.12 and a test caught that the real case
 * that motivated the guard — a face measured at 1.21 described as "얼굴이
 * 둥글고" — fell straight through the gap. Check any change against measured
 * values, not intuition.
 */
const LONG_FACE = 1.2;
const ROUND_FACE = 1.15;
/** Outer-corner tilt in degrees, beyond which the eyes read as clearly
 * upturned or clearly downturned. */
const UPTURNED_EYES = 3;
/** 0-1 luminance bounds for hair that is unambiguously dark or light. */
const DARK_HAIR = 0.3;
const LIGHT_HAIR = 0.5;

interface Claim {
  /** Words that assert the claim in Korean. */
  words: string[];
  /** True when this face's measurements make the claim false. */
  contradicts: (f: FaceFeatures) => boolean;
}

const CLAIMS: Claim[] = [
  {
    words: ["둥근 얼굴", "동그란 얼굴", "둥글고", "동그랗고", "둥근 얼굴형", "통통"],
    contradicts: (f) => f.lengthToWidth >= LONG_FACE,
  },
  {
    words: ["갸름", "긴 얼굴", "길쭉"],
    contradicts: (f) => f.lengthToWidth <= ROUND_FACE,
  },
  {
    words: ["처진 눈", "순한 눈매", "내려간 눈"],
    contradicts: (f) => f.eyeSlant >= UPTURNED_EYES,
  },
  {
    words: ["올라간 눈", "날카로운 눈매", "매서운"],
    contradicts: (f) => f.eyeSlant <= -UPTURNED_EYES,
  },
  {
    words: ["검은 머리", "검은색 머리", "흑발", "어두운 머리"],
    contradicts: (f) => f.hairBrightness >= LIGHT_HAIR,
  },
  {
    words: ["밝은 머리", "금발", "밝게 염색", "탈색"],
    contradicts: (f) => f.hairBrightness <= DARK_HAIR,
  },
];

/**
 * True when the sentence asserts something this face's measurements deny.
 *
 * Only fires on a direct conflict — a reason that simply says nothing
 * measurable is not penalised here, because vagueness and falsehood deserve
 * different treatment and only one of them is checkable.
 */
export function reasonContradictsFace(reason: string, features: FaceFeatures | null): boolean {
  if (!reason || !features) return false;
  return CLAIMS.some(
    (claim) => claim.words.some((w) => reason.includes(w)) && claim.contradicts(features)
  );
}

export interface GuardablePick {
  slug: string;
  reason: string;
}

/** How many picks may share one pokedex silhouette. Two leaves room for a
 * genuine evolution-line resemblance without letting one shape take the set. */
const MAX_PER_SHAPE = 2;

/**
 * Trims the judge's picks down to the ones worth showing.
 *
 * Order is the model's and is preserved — it is the one part of the judgement
 * that holds up. What changes is which picks survive: a contradicted reason is
 * blanked rather than shown as a false statement about someone's face, and a
 * silhouette that already appears twice is skipped so the five don't collapse
 * into one impression.
 *
 * Falls back to filling from the skipped picks rather than returning fewer
 * than asked for — an incomplete result is worse than a repetitive one.
 */
export function applyPickGuards(
  picks: GuardablePick[],
  pokedex: Record<string, PokedexEntry>,
  features: FaceFeatures | null,
  want: number
): GuardablePick[] {
  const kept: GuardablePick[] = [];
  const skipped: GuardablePick[] = [];
  const shapeCount = new Map<string, number>();

  for (const pick of picks) {
    const cleaned: GuardablePick = {
      slug: pick.slug,
      reason: reasonContradictsFace(pick.reason, features) ? "" : pick.reason,
    };
    const shape = pokedex[pick.slug]?.shape ?? "";
    const used = shapeCount.get(shape) ?? 0;
    if (shape && used >= MAX_PER_SHAPE) {
      skipped.push(cleaned);
      continue;
    }
    shapeCount.set(shape, used + 1);
    kept.push(cleaned);
    if (kept.length >= want) break;
  }

  for (const pick of skipped) {
    if (kept.length >= want) break;
    kept.push(pick);
  }
  return kept.slice(0, want);
}
