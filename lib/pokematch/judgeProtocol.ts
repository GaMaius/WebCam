// Pure request/response handling for the PokéMatch judge. Kept out of the
// route handler so it can be tested with `node --test` (the route imports
// next/server, which isn't loadable there) — and because parsing an LLM's
// output is the part most likely to be wrong in a way a build won't catch.
//
// The judge is a VISION model: it receives the cropped face image and NAMES
// the species it resembles. Two consequences that shape everything here:
//   - The candidate list is no longer sent. It cost ~1,050 tokens of a
//     6,070-token request and taught the model nothing — it already knows
//     every Pokemon. The pool still gates the ANSWER: normalizePicks resolves
//     the name against it, so anything banned or unavailable is dropped, which
//     is what the numbered list used to do.
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
export const SYSTEM_PROMPT = `You judge a "which Pokemon do you look like" service. Look at the user's face photo and name the Pokemon it most resembles.

Rules:
1. Judge from the photo itself: face shape, eye shape and size, nose and mouth, jawline, hairstyle and hair colour, skin tone, and overall impression.
2. Answer with the ENGLISH species name, spelled correctly. Choose only well-known species that a casual fan would picture instantly — an obscure one is not a result, it is a shrug.
2a. Never name a species that is filthy, decaying, a joke about being useless, or an unsettling design (Muk, Garbodor, Magikarp, Jynx, Hypno and the like). The input is a real person's face and the answer has to be something they enjoy being shown.
3. Pick exactly ${REQUEST_PICK_COUNT}, most similar first. Only the top few are shown, so put real effort into the ordering.
4. They must not all give the same impression. Don't fill them with one evolution family; mix different impressions, but rank the single best fit first.
5. Each reason must cite a DIFFERENT feature. Do not reword one observation (e.g. "big eyes") over and over — that is making one pick repeatedly, not several. Spread across eye shape, face shape, hairstyle, mood, skin tone, expression.
7. Different people must get different results. Base the choice on what is specific to THIS face.
7c. Commit to the answer. Before choosing, decide which two or three features of this face are the most distinctive, then pick the species that match THOSE. Shown the same photo again you should reach the same conclusion — if several species feel equally fine, you have not narrowed it down yet.
7a. ⚠️ DO NOT DEFAULT TO FAMOUS MASCOTS. Pikachu, Psyduck, Clefairy, Togepi, Eevee and similar household-name cute species are the lazy answer and they fit almost anybody, which makes them wrong almost every time. Pick one only if this face matches it distinctly better than every alternative.
7b. Let the measured notes steer you where they are decisive. Upturned or sharp eyes suit a sharp-featured species, not a round mascot; a long face suits an elongated design; dark hair suits a dark-coloured species. A round cute species needs a genuinely round soft face to earn the pick.
8. Write each reason as ONE Korean sentence, at most 45 characters, citing at least one thing actually visible in the photo. Example: "눈꼬리가 올라가고 턱선이 뚜렷해 잘 맞습니다"
9. NEVER write a Pokemon name inside the reason — the name is displayed separately, so a name you write will contradict it. Describe only what you see in the face.
10. This is for fun. Write only sentences the reader would enjoy. Never judge body or looks: the words "통통한", "뚱뚱한", "넓은 코", "어색한", "이상한", "못생긴" are forbidden. Use appealing features instead — eyes, impression, mood, hairstyle.
11. Say only what is visible. Do not invent features; calling a slender face "통통한" means you have no evidence.
12. Never guess the person's identity or name any real person.

Output exactly one JSON object, nothing else. No scores.
{"picks":[{"name":"Riolu","reason":"..."},{"name":"Zorua","reason":"..."}]}`;


/** English scaffolding for the same reason SYSTEM_PROMPT is English — Korean
 * costs about 2.7 tokens per character here. The face notes themselves are
 * still Korean (they come from describeFaceFeatures) and are the remaining
 * Korean cost in the request. */
/**
 * ⚠️ THE CANDIDATE LIST IS DELIBERATELY NOT IN THE PROMPT.
 *
 * It used to be: 291 numbered names, measured at ~1,050 tokens of a
 * 6,070-token request against an 8K per-minute cap. The model already knows
 * every Pokemon, so those tokens were never teaching it anything — the list
 * was there to stop hallucination and to enforce the ban list.
 *
 * Both of those still hold; they just don't have to be paid for in tokens.
 * The client still sends the pool, so normalizePicks resolves whatever the
 * model names against it and drops anything absent. A banned or unavailable
 * species fails to resolve exactly as an out-of-range number used to.
 *
 * `candidates` stays in the signature because every caller has it and the
 * resolver needs the same array; it simply isn't rendered any more.
 */
export function buildUserPrompt(description: string, _candidates: CandidateInput[]): string {
  const sections = [
    `Name the ${REQUEST_PICK_COUNT} Pokemon this face most resembles, best first.`,
  ];
  if (description.trim()) {
    sections.push(
      `[Measured face notes — the photo comes first, these are supporting detail]\n${description.slice(
        0,
        MAX_DESCRIPTION_CHARS
      )}`
    );
  }
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
 * config rejects it, so accept fenced, prefixed and prose-wrapped JSON.
 *
 * The UNTERMINATED `<think>` case matters as much as the closed one: when the
 * completion budget runs out mid-thought there is no closing tag, and without
 * this the leftover reasoning prose gets scanned for braces and can yield a
 * fragment that parses into nonsense. Everything after an unclosed tag is
 * thinking, so it all goes. */
export function extractJson(content: string): unknown {
  const trimmed = content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
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
/** Loose key for matching a species name the model wrote against our own —
 * case, spacing, punctuation and form suffixes vary ("Mr. Mime", "mr_mime",
 * "Lycanroc (Midday)"). */
function nameKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Name -> slug for everything the app is willing to show.
 *
 * This is what makes it safe to stop listing 291 candidates in the prompt.
 * The list still exists — the client sends it, it just isn't spent as tokens —
 * so a species the model names is only accepted if it is in the curated pool,
 * which is what enforces BANNED_SLUGS. A name that isn't in the pool (an
 * excluded species, a form we have no sprite for, an invented one) resolves to
 * nothing and the pick is dropped, exactly as an out-of-range number was.
 */
function buildNameIndex(candidates: CandidateInput[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const c of candidates) {
    for (const name of [c.nameEn, c.nameKo, c.slug]) {
      if (name) index.set(nameKey(name), c.slug);
    }
  }
  return index;
}

/**
 * Why a successful (HTTP 200) call still produced nothing renderable.
 *
 * ⚠️ This exists because "judge_unusable" on its own is undiagnosable, and the
 * two things it can mean need OPPOSITE fixes:
 *   - the completion budget was spent on reasoning and no answer was written
 *     ("empty_content" / finish=length) — raise max_completion_tokens
 *   - the model named species that aren't in the pool ("unresolved:…") — a pool
 *     or prompt problem, where raising the budget would do nothing
 * Guessing between them is exactly the mistake this feature has already paid
 * for twice, so the answer is reported instead of inferred.
 *
 * Safe to return to the browser: it contains the model's own species names and
 * a short snippet of its output about the requester's own scan, never the key,
 * the organization or the image.
 */
export function describeUnusable(content: string, parsed: unknown): string {
  if (!content.trim()) return "empty_content";
  if (parsed === null || parsed === undefined) {
    return `unparsed:${content.trim().replace(/\s+/g, " ").slice(0, 80)}`;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { picks?: unknown })?.picks)
    ? (parsed as { picks: unknown[] }).picks
    : [];
  if (list.length === 0) return "no_picks_in_json";

  const named = list
    .map((item) => {
      if (typeof item === "string" || typeof item === "number") return String(item);
      if (item && typeof item === "object") {
        const p = item as Record<string, unknown>;
        const v = p.name ?? p.pokemon ?? p.slug ?? p.n;
        return v == null ? "" : String(v);
      }
      return "";
    })
    .map((s) => s.replace(/[^A-Za-z0-9 .'-]/g, "").trim())
    .filter(Boolean)
    .slice(0, 8);

  return named.length ? `unresolved:${named.join(",")}` : "unnamed_picks";
}

export function normalizePicks(raw: unknown, candidates: CandidateInput[]): Pick[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { picks?: unknown })?.picks)
    ? (raw as { picks: unknown[] }).picks
    : [];

  const bySlug = new Map(candidates.map((c) => [c.slug, c]));
  const byName = buildNameIndex(candidates);
  const picks: Pick[] = [];
  const used = new Set<string>();

  for (const item of list) {
    let slug = "";
    let reason = "";

    if (typeof item === "number" || typeof item === "string") {
      const n = Number(item);
      if (Number.isInteger(n)) slug = candidates[n - 1]?.slug ?? "";
      else if (typeof item === "string") {
        slug = bySlug.has(item.trim().toLowerCase())
          ? item.trim().toLowerCase()
          : byName.get(nameKey(item)) ?? "";
      }
    } else if (item && typeof item === "object") {
      const p = item as Record<string, unknown>;
      const n = Number(p.n ?? p.number ?? p.index);
      if (Number.isInteger(n) && n >= 1 && n <= candidates.length) {
        slug = candidates[n - 1].slug;
      } else if (typeof p.slug === "string" && bySlug.has(p.slug.trim().toLowerCase())) {
        slug = p.slug.trim().toLowerCase();
      } else {
        // The model now answers with NAMES, since listing 291 candidates cost
        // ~1,050 tokens of a 6,070-token request. Anything it names that isn't
        // in the pool simply doesn't resolve.
        const named = p.name ?? p.pokemon ?? p.slug;
        if (typeof named === "string") slug = byName.get(nameKey(named)) ?? "";
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
