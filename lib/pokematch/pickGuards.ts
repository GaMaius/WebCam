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
    words: [
      "둥근 얼굴", "동그란 얼굴", "둥글고", "동그랗고", "둥근 얼굴형", "통통",
      // Observed on a face measured at 1.35: "부드러운 얼굴 라인이 사랑스러운
      // 인상을 줍니다". These are roundness claims in softer words, so they are
      // checkable the same way. The bare word 부드러운 is NOT here — "부드러운
      // 눈매" says nothing about shape and vagueness isn't falsehood.
      "부드러운 얼굴 라인", "부드러운 얼굴선", "부드러운 얼굴 윤곽", "부드러운 얼굴형",
    ],
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
 * Dice coefficient over Korean character bigrams. Cheap, needs no tokenizer,
 * and is stable against the reordering the model does when it reuses a
 * sentence ("부드러운 얼굴 라인과 차분한 눈매가…" / "부드러운 피부톤과 차분한
 * 눈매가…").
 */
function reasonOverlap(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.replace(/[^가-힣a-zA-Z0-9]/g, "");
    const out = new Set<string>();
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/**
 * How much two reasons may overlap before the second is treated as a repeat.
 *
 * ⚠️ MEASURED, NOT CHOSEN. Computed over the reasons of four real runs: within
 * a single healthy scan the worst pair scored 0.138 and 0.258, while the run
 * where the model collapsed into reworking one sentence had a median of 0.423
 * and a worst pair of 0.842. 0.45 sits in the gap.
 *
 * Rule 5 of the prompt already asks for a different feature per pick and the
 * model ignores it under pressure, which is what this enforces. Note the
 * borderline case is a true positive, not a false one: "어두운 머리와 위를 향한
 * 눈매" against "검은 머리와 날카로운 눈매" scores 0.571, and those are the same
 * observation twice.
 */
const MAX_REASON_OVERLAP = 0.45;

/**
 * Stable partition putting household-name species ahead of the rest.
 *
 * ⚠️ MEASURED, and it replaces a filter that was doing this job by DELETION.
 * The judge's answer used to be gated on the 294-species curated pool, which
 * silently deleted anything outside it — that cost real answers (Emolga,
 * Braixen, Aipom all vanished from one run) so the gate was widened to every
 * shippable species. The very next run showed what the narrow gate had also
 * been doing: the model led with Crobat, then Dunsparce, Skuntank and Bonsly.
 * A bat, a drill-snake, a skunk. Of its eight picks only three (Zorua, Absol,
 * Vulpix) were species a person reads as a lookalike, and the old pool would
 * have kept exactly those three.
 *
 * So familiarity is a PREFERENCE now, not a gate. A species outside the pool is
 * still shown when there aren't five better-known ones — which is how Emolga
 * gets to appear — but it doesn't take the top slot from Zorua. The model's
 * relative order survives inside each group; this only decides which group goes
 * first.
 */
export function preferFamiliar(picks: GuardablePick[], familiar: Set<string>): GuardablePick[] {
  if (familiar.size === 0) return picks;
  return [
    ...picks.filter((p) => familiar.has(p.slug)),
    ...picks.filter((p) => !familiar.has(p.slug)),
  ];
}

/**
 * Trims the judge's picks down to the ones worth showing.
 *
 * Order is the model's and is largely preserved — it is the part of the
 * judgement that holds up best. What changes is which picks survive: familiar
 * species come first (see preferFamiliar), a contradicted reason is blanked
 * rather than shown as a false statement about someone's face, and a silhouette
 * that already appears twice is skipped so the five don't collapse into one
 * impression.
 *
 * Falls back to filling from the skipped picks rather than returning fewer
 * than asked for — an incomplete result is worse than a repetitive one.
 */
export function applyPickGuards(
  picks: GuardablePick[],
  pokedex: Record<string, PokedexEntry>,
  features: FaceFeatures | null,
  want: number,
  familiar: Set<string> = new Set()
): GuardablePick[] {
  const shapeCount = new Map<string, number>();

  /** Runs the silhouette cap over one group, blanking false reasons as it
   * goes. The count is shared across groups so the cap still bounds the whole
   * set. */
  const reasonsUsed: string[] = [];
  const cap = (group: GuardablePick[]) => {
    const kept: GuardablePick[] = [];
    const skipped: GuardablePick[] = [];
    for (const pick of group) {
      const cleaned: GuardablePick = {
        slug: pick.slug,
        reason: reasonContradictsFace(pick.reason, features) ? "" : pick.reason,
      };
      const shape = pokedex[pick.slug]?.shape ?? "";
      const used = shapeCount.get(shape) ?? 0;
      // ⚠️ A REWORDED REASON IS A REPEATED PICK. Under pressure the model
      // stops judging and starts filling the list, and the tell is textual
      // before it is anything else: one run returned twelve variations of
      // "부드러운 얼굴 라인과 …가 귀여운 포켓몬과 잘 어울립니다". A pick whose
      // only justification is another pick's sentence has not been justified.
      const repeats = cleaned.reason
        ? reasonsUsed.some((r) => reasonOverlap(r, cleaned.reason) >= MAX_REASON_OVERLAP)
        : false;
      if (repeats || (shape && used >= MAX_PER_SHAPE)) {
        skipped.push(cleaned);
        continue;
      }
      shapeCount.set(shape, used + 1);
      if (cleaned.reason) reasonsUsed.push(cleaned.reason);
      kept.push(cleaned);
    }
    return { kept, skipped };
  };

  const isFamiliar = (p: GuardablePick) => familiar.has(p.slug);
  const fam = cap(familiar.size ? picks.filter(isFamiliar) : []);
  const rest = cap(familiar.size ? picks.filter((p) => !isFamiliar(p)) : picks);

  // ⚠️ A CAPPED FAMILIAR PICK OUTRANKS AN UNCAPPED UNFAMILIAR ONE — fam.skipped
  // comes before rest.kept. Replaying the real run showed why: Zorua, Absol and
  // Vulpix are all `quadruped`, so the cap pushed Vulpix out and handed its slot
  // to Crobat, a bat. Three familiar quadrupeds is a repetitive five; two good
  // ones plus a bat, a drill-snake and a skunk is a wrong five, and repetitive
  // is the lesser fault.
  return [...fam.kept, ...fam.skipped, ...rest.kept, ...rest.skipped].slice(0, want);
}
