// Pure request/response handling for the PokéMatch judge. Kept out of the
// route handler so it can be tested with `node --test` (the route imports
// next/server, which isn't loadable there) — and because parsing an LLM's
// output is the part most likely to be wrong in a way a build won't catch.
//
// The judge is a VISION model: it receives the cropped face image and picks
// from a numbered list of species. Two consequences that shape everything here:
//   - Candidates are just numbers + English names. No appearance descriptions,
//     because the model already knows what these species look like, and no
//     Korean, because the model's knowledge is anchored to the English names
//     (which also tokenize cheaper — measured, see CLAUDE.md).
//   - The measured face descriptors are supporting detail, not the input. They
//     stay because they're precise where a glance is vague (exact ratios,
//     ITA skin tone), but the image is what's actually being judged.

/** Shown to the user. */
export const PICK_COUNT = 5;
/** Asked of the model. The surplus is what makes the quality guards in
 * pickGuards affordable — a pick can be dropped for contradicting the face's
 * measurements, or for repeating a silhouette, without leaving a short list.
 * Costs about 60 output tokens. */
export const REQUEST_PICK_COUNT = 8;
export const MAX_CANDIDATES = 400;
export const MAX_DESCRIPTION_CHARS = 4000;

/** Base64 payload cap for the face crop. A 448x448 JPEG lands around 40KB;
 * this leaves generous headroom while keeping the request far below both
 * Vercel's 4.5MB body limit and Groq's 20MB image limit. */
export const MAX_IMAGE_BYTES = 1_500_000;
const IMAGE_DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

export interface CandidateInput {
  slug: string;
  nameEn?: string;
  nameKo?: string;
}

export interface Pick {
  slug: string;
  reason: string;
}

const SLUG_RE = /^[a-z0-9_-]{1,40}$/;

/**
 * Appearance judgements the result must never show. The input is somebody's
 * face, so a sentence calling them chubby or awkward is a worse outcome than
 * showing no sentence at all — which is exactly what happens when one of these
 * matches. The prompt forbids them too; this is the enforcement, because a
 * prompt rule is a request and this is a guarantee.
 *
 * Observed in real output before this existed: "통통한 얼굴형" and "약간 어색해
 * 보이는 표정", both aimed at a face the measurements described as slender.
 */
const DEMEANING_TERMS = [
  "통통", "뚱뚱", "살찐", "포동", "두툼한 얼굴",
  "못생", "안 예쁘", "안예쁘", "볼품", "촌스",
  "어색", "이상한", "우스", "웃긴 얼굴", "특이하게 생",
  "넓은 코", "낮은 코", "큰 코", "작은 눈", "찢어진 눈",
];

/**
 * Reason text the UI can show, or "" if it has to be withheld.
 *
 * Two things disqualify a sentence. A demeaning descriptor, per above. And any
 * run of latin letters: the model is given English species names but the UI
 * shows the Korean ones, so a name that leaks into the reason contradicts the
 * label right next to it — real output produced "싸이duck" under a row titled
 * 고라파덕. A Korean sentence about a face has no other need for latin script.
 */
export function sanitizeReason(raw: string): string {
  const reason = raw.trim().slice(0, 120);
  if (!reason) return "";
  if (/[A-Za-z]{2,}/.test(reason)) return "";
  if (DEMEANING_TERMS.some((term) => reason.includes(term))) return "";
  return reason;
}

/** Whitelists and truncates whatever the browser posted. Everything here ends
 * up inside a prompt, so nothing is passed through on trust. */
export function sanitizeCandidates(raw: unknown): CandidateInput[] {
  if (!Array.isArray(raw)) return [];
  const out: CandidateInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const slug = typeof c.slug === "string" ? c.slug : "";
    if (!SLUG_RE.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      nameEn: typeof c.nameEn === "string" ? c.nameEn.slice(0, 40) : undefined,
      nameKo: typeof c.nameKo === "string" ? c.nameKo.slice(0, 40) : undefined,
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** True only for a well-formed, size-capped image data URL. Anything else is
 * refused rather than forwarded — this string goes straight to a paid API. */
export function isUsableImage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_IMAGE_BYTES &&
    IMAGE_DATA_URL_RE.test(value)
  );
}

/**
 * Pulls the useful facts out of Groq's 429 body without echoing it wholesale —
 * the raw message names the organization, which doesn't belong in a public
 * response. What we keep is which limit tripped (tokens/requests per
 * minute/day), the limit/used/requested numbers, and how long to wait.
 *
 * This exists because a bare 429 is ambiguous in the way that matters most: a
 * per-minute burst cap and a spent daily budget look identical but need
 * opposite fixes, and guessing between them cost a round of debugging.
 */
export function summarizeRateLimit(body: string, retryAfter: string | null): string {
  const kind = /\b(?:tokens|requests) per (?:minute|day)\b/i.exec(body)?.[0];
  const numbers = /Limit (\d+), Used (\d+), Requested (\d+)/i.exec(body);
  const wait = retryAfter ?? /try again in ([\d.]+m?[\d.]*s?)/i.exec(body)?.[1];

  const parts: string[] = [];
  if (kind) parts.push(kind.toLowerCase().replace(/\s+/g, "_"));
  if (numbers) parts.push(`limit=${numbers[1]},used=${numbers[2]},requested=${numbers[3]}`);
  if (wait) parts.push(`retry_after=${wait}`);
  return parts.join(" ") || "unspecified";
}

/**
 * ⚠️ WRITTEN IN ENGLISH ON PURPOSE — DO NOT TRANSLATE BACK TO KOREAN.
 *
 * This model's tokenizer has no real Korean coverage and falls back to bytes:
 * measured at roughly 2.7 tokens per Hangul character, against about 0.25 for
 * English. The Korean version of these same rules cost about 3,600 tokens —
 * more than the candidate list, the face notes and the image combined — and it
 * was what pushed each request over the 8K per-minute cap, so every other scan
 * got a 429 and fell back to the local ranker. Users read that alternation as
 * "the answer changes every time", because the two engines disagree completely.
 *
 * Only the `reason` output stays Korean, since users read it. The banned words
 * in rule 10 must stay Korean too — they describe the output being filtered.
 */
export const SYSTEM_PROMPT = `You judge a "which Pokemon do you look like" service. Look at the user's face photo and pick the closest matches from the numbered candidate list.

Rules:
1. Judge from the photo itself: face shape, eye shape and size, nose and mouth, jawline, hairstyle and hair colour, skin tone, and overall impression.
2. Refer to candidates by NUMBER. Only numbers that appear in the list.
3. Pick exactly ${REQUEST_PICK_COUNT}, most similar first. Only the top few are shown, so put real effort into the ordering.
4. They must not all give the same impression. Don't fill them with one evolution family; mix different impressions, but rank the single best fit first.
5. Each reason must cite a DIFFERENT feature. Do not reword one observation (e.g. "big eyes") over and over — that is making one pick repeatedly, not several. Spread across eye shape, face shape, hairstyle, mood, skin tone, expression.
6. The list order is meaningless (it is shuffled). Do not favour low numbers; consider the whole list.
7. Different people must get different results. Base the choice on what is specific to THIS face.
7a. ⚠️ DO NOT DEFAULT TO FAMOUS MASCOTS. Pikachu, Psyduck, Clefairy, Togepi, Eevee and similar household-name cute species are the lazy answer and they fit almost anybody, which makes them wrong almost every time. Pick one only if this face matches it distinctly better than every alternative.
7b. Let the measured notes steer you where they are decisive. Upturned or sharp eyes suit a sharp-featured species, not a round mascot; a long face suits an elongated design; dark hair suits a dark-coloured species. A round cute species needs a genuinely round soft face to earn the pick.
8. Write each reason as ONE Korean sentence, at most 45 characters, citing at least one thing actually visible in the photo. Example: "눈꼬리가 올라가고 턱선이 뚜렷해 잘 맞습니다"
9. NEVER write a Pokemon name inside the reason — the name is displayed separately, so a name you write will contradict it. Describe only what you see in the face.
10. This is for fun. Write only sentences the reader would enjoy. Never judge body or looks: the words "통통한", "뚱뚱한", "넓은 코", "어색한", "이상한", "못생긴" are forbidden. Use appealing features instead — eyes, impression, mood, hairstyle.
11. Say only what is visible. Do not invent features; calling a slender face "통통한" means you have no evidence.
12. Never guess the person's identity or name any real person.

Output exactly one JSON object, nothing else. No names, no scores.
{"picks":[{"n":7,"reason":"..."},{"n":21,"reason":"..."}]}`;

/**
 * The numbered candidate list.
 *
 * English names, because that's where the model's knowledge of these species
 * lives — the Korean name is resolved back on our side for display. Numbering
 * follows the array order and is what normalizePicks resolves against, so the
 * array must not be reordered between building the prompt and reading the
 * reply.
 */
export function buildCandidateList(candidates: CandidateInput[]): string {
  return candidates.map((c, i) => `${i + 1}.${c.nameEn ?? c.slug}`).join(" ");
}

/** English scaffolding for the same reason SYSTEM_PROMPT is English — Korean
 * costs about 2.7 tokens per character here. The face notes themselves are
 * still Korean (they come from describeFaceFeatures) and are the remaining
 * Korean cost in the request. */
export function buildUserPrompt(description: string, candidates: CandidateInput[]): string {
  const sections = [`Pick the ${REQUEST_PICK_COUNT} candidates this face most resembles, best first.`];
  if (description.trim()) {
    sections.push(
      `[Measured face notes — the photo comes first, these are supporting detail]\n${description.slice(
        0,
        MAX_DESCRIPTION_CHARS
      )}`
    );
  }
  sections.push(`[${candidates.length} candidates]\n${buildCandidateList(candidates)}`);
  return sections.join("\n\n");
}

/** Chat messages for the vision call. The image goes last so the instructions
 * and candidate list are already in context when the model looks at it. */
export function buildMessages(
  description: string,
  candidates: CandidateInput[],
  imageDataUrl: string
) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: buildUserPrompt(description, candidates) },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

/** Models emit reasoning, and json_object mode isn't guaranteed if the model
 * config rejects it, so accept fenced, prefixed and prose-wrapped JSON. */
export function extractJson(content: string): unknown {
  const trimmed = content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```(?:json)?/g, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Turns the model's output into picks we can actually render.
 *
 * Picks arrive as 1-based numbers into `candidates` (the same array
 * buildUserPrompt numbered), which is why an out-of-range or invented
 * identifier simply can't survive: it doesn't resolve to a candidate. A bare
 * number, or a legacy `{slug}` object, is accepted too — cheap tolerance for
 * a model that ignores the requested shape.
 *
 * Note there is no `percent` here. Ranking is the only thing the model is
 * asked for; the displayed similarity is computed from the embedding z-scores
 * client-side, where it's derived from real numbers instead of invented ones.
 */
export function normalizePicks(raw: unknown, candidates: CandidateInput[]): Pick[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { picks?: unknown })?.picks)
    ? (raw as { picks: unknown[] }).picks
    : [];

  const bySlug = new Map(candidates.map((c) => [c.slug, c]));
  const picks: Pick[] = [];
  const used = new Set<string>();

  for (const item of list) {
    let slug = "";
    let reason = "";

    if (typeof item === "number" || typeof item === "string") {
      const n = Number(item);
      if (Number.isInteger(n)) slug = candidates[n - 1]?.slug ?? "";
      else if (typeof item === "string" && bySlug.has(item.trim().toLowerCase())) {
        slug = item.trim().toLowerCase();
      }
    } else if (item && typeof item === "object") {
      const p = item as Record<string, unknown>;
      const n = Number(p.n ?? p.number ?? p.index);
      if (Number.isInteger(n) && n >= 1 && n <= candidates.length) {
        slug = candidates[n - 1].slug;
      } else if (typeof p.slug === "string" && bySlug.has(p.slug.trim().toLowerCase())) {
        slug = p.slug.trim().toLowerCase();
      }
      if (typeof p.reason === "string") reason = sanitizeReason(p.reason);
    }

    if (!slug || used.has(slug)) continue;
    used.add(slug);
    picks.push({ slug, reason });
    if (picks.length >= REQUEST_PICK_COUNT) break;
  }

  return picks;
}
