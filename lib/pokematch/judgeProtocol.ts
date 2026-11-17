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
 * measurements, repeating a silhouette, or being an obscure species, without
 * leaving a short list.
 *
 * ⚠️⚠️ DO NOT RAISE THIS. Twelve was tried, to give the familiarity ranking a
 * deeper pool to draw from, and it broke the judgement itself. Measured across
 * four runs:
 *
 *   8  → Houndour, Pancham, Zorua, Riolu … distinct species, specific reasons
 *   8  → Crobat, Slowking, Dunsparce … odd species, but still distinct
 *   12 → Mimikyu, Gothita, Elgyem … drifting cute, reasons starting to repeat
 *   12 → Eevee, Jigglypuff, Munchlax, Snorlax, Pikachu, Togepi, Bulbasaur,
 *        Charmander, Squirtle, Mew … every one a starter or a mascot, with one
 *        sentence reworded twelve times, and Pikachu called "전설의 포켓몬"
 *
 * Asked for twelve, the model cannot find twelve distinctive matches, so it
 * switches from judging to enumerating famous Pokemon. And because it plans the
 * whole list before writing, THE FIRST PICK DEGRADES TOO — the collapse is not
 * confined to the tail that gets discarded.
 *
 * Eight leaves enough surplus for the guards (a pick can be dropped for
 * contradicting the measurements, repeating a silhouette, or reusing another
 * pick's reason) without pushing the model into list-filling. */
export const REQUEST_PICK_COUNT = 8;
/** ⚠️ Sized for the whole shippable gallery, not the old 294-species curated
 * pool — the client now sends everything that isn't banned, because gating the
 * answer on the narrow pool was deleting half of it. These never become tokens
 * (the prompt stopped listing them); they only have to resolve names. */
export const MAX_CANDIDATES = 1200;
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
  /** Which trait slots the model says this species shares (MATCH_SLOTS).
   * Self-reported, so it only orders picks; the rerank verifies visually. */
  match?: string[];
}

/** The fixed trait slots both stages work in. "mood" is deliberately absent:
 * a calm neutral face is in almost every selfie, so it never counts as a
 * shared feature. */
export const MATCH_SLOTS = ["hair", "eyes", "face", "mouth", "accessory", "colors"] as const;

function parseMatch(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const slots = new Set<string>();
  for (const v of value) {
    const k = typeof v === "string" ? v.trim().toLowerCase() : "";
    const slot =
      k === "color" || k === "colour" || k === "colours"
        ? "colors"
        : k === "glasses" || k === "accessories"
        ? "accessory"
        : k === "eye"
        ? "eyes"
        : k === "smile" || k === "expression" || k === "lips"
        ? "mouth"
        : k;
    if ((MATCH_SLOTS as readonly string[]).includes(slot)) slots.add(slot);
  }
  return [...slots];
}

/**
 * Picks that share TWO OR MORE trait slots with the face come first; the rest
 * keep their order behind them. Stable, nothing deleted, and a no-op when the
 * model gave no "match" lists at all.
 *
 * ⚠️ WHY (2026-11-17, user: "특징을 하나만 뽑아서 … 그 특징 하나만을 가진
 * 포켓몬이 나온다"): with "name a concrete feature" enforced, the model
 * started choosing species on ONE feature — glasses → anything with eye
 * rings. One shared feature is not resemblance. This only decides the order
 * when the rerank fails; when it runs, its per-feature grades decide.
 */
export function preferBroadMatches<T extends { match?: string[] }>(picks: T[]): T[] {
  if (!picks.some((p) => p.match !== undefined)) return picks;
  const broad = (p: T) => (p.match?.length ?? 0) >= 2;
  return [...picks.filter(broad), ...picks.filter((p) => !broad(p))];
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
  // ⚠️ Euphemisms for the same thing, and they slipped through because the
  // list was literal. Observed: "폭신한 볼륨과 편안한 표정이 잘 어울립니다" on a
  // face measured at 1.35 length-to-width. The rule is not "avoid the word
  // 통통", it is "never comment on how full someone's face is", so the polite
  // phrasings have to go too. "볼륨감 있는 입술" stays allowed — full lips are
  // a neutral feature the pipeline itself measures.
  "폭신", "푸근한 얼굴", "살집", "볼륨감 있는 얼굴", "볼륨 있는 얼굴",
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
  if (DENIES_RESEMBLANCE.test(reason)) return "";
  return reason;
}

/**
 * A sentence that says the two DON'T look alike. The graded rerank writes a
 * reason for every panel, including the ones it scores near zero, and those
 * come back as "닮은 점을 찾을 수 없습니다" (observed in production,
 * 2026-11-17). Shown under a result titled "가장 닮은 포켓몬" that reads as a
 * bug, so it is withheld like any other unusable reason.
 */
const DENIES_RESEMBLANCE =
  /(공통점|닮은 점|비슷한 점|유사점)[^.]{0,12}(없|않)|닮지 않|비슷하지 않|찾을 수 없|알 수 없|보이지 않/;

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
5. Each reason must cite a DIFFERENT feature. Do not reword one observation (e.g. "big eyes", "calm mood") over and over — that is making one pick repeatedly, not several. Spread across hairstyle and hair colour, glasses or other accessories, eye shape, eyebrows, face shape, jawline, skin tone.
5a. Start from what is MOST visible: hairstyle (bangs, parting, colour), glasses, eye shape, face shape. Glasses are a real feature — Pokemon with eye rings, goggle-like markings or dark patches around the eyes echo them. A calm or neutral expression is common to almost every photo, so it is never enough on its own to choose a species — but a DISTINCTIVE expression is a real feature: a wide open smile, smiling eyes, raised round cheeks, a pout. Record it in the "mouth" slot and match it like any other feature.
7. Different people must get different results. Base the choice on what is specific to THIS face.
7c. Commit to the answer. FIRST fill "traits", one short English phrase per slot: "hair" (style and colour, e.g. "straight black bangs"), "eyes" (shape and brows), "face" (shape and proportions), "mouth" (mouth shape and expression, e.g. "wide open smile, raised cheeks", or "neutral" if nothing distinctive), "accessory" (e.g. "square glasses", or "none"), "colors" (hair/skin palette). THEN pick species. Shown the same photo again you should reach the same traits and the same conclusion.
7e. Also write "traitsKo": the same two or three features as short Korean noun phrases joined by " · " (at most 30 characters), e.g. "검은 일자 앞머리 · 사각 안경 · 갸름한 얼굴". The user sees this, so the same politeness rules as the reasons apply.
7d. ⚠️ ONE SHARED FEATURE IS NOT RESEMBLANCE. Every pick must share AT LEAST TWO of the trait slots with the face — list them in "match" (slot names: hair, eyes, face, mouth, accessory, colors; mood never counts, and "mouth" counts only when the expression is distinctive). Glasses alone do not make a species with eye rings a match; it must also share the hair, the face shape or the colours. Prefer species that share three. If a species shares only one slot, however striking, leave it out.
7a. ⚠️ DO NOT DEFAULT TO FAMOUS MASCOTS. Choosing Pikachu, Psyduck, Clefairy, Togepi, Eevee, the starters and similar household-name species BY DEFAULT is the lazy answer, because a vague cute impression fits almost anybody. They are NOT banned: pick one exactly like any other species — when it shares at least two concrete slots with this face (for example the same wide smile and round cheeks, plus the eye shape).
7b. Let the measured notes steer you where they are decisive. Upturned or sharp eyes suit a sharp-featured species, not a round mascot; a long face suits an elongated design; dark hair suits a dark-coloured species. A round cute species needs a genuinely round soft face to earn the pick.
8. Write each reason as ONE Korean sentence, at most 45 characters, naming the CONCRETE features in its "match" — ideally two of them (hair, bangs, glasses, eye shape, eyebrows, face shape, jaw, colours). A reason that only describes mood ("차분한 분위기", "고요한 인상") is not allowed. Example: "검은 일자 앞머리와 눈 주위 안경 테가 무늬와 닮았어요"
9. NEVER write a Pokemon name inside the reason — the name is displayed separately, so a name you write will contradict it. Describe only what you see in the face.
10. This is for fun. Write only sentences the reader would enjoy. Never judge body or looks: the words "통통한", "뚱뚱한", "넓은 코", "어색한", "이상한", "못생긴" are forbidden. Use appealing features instead — eyes, impression, mood, hairstyle.
11. Say only what is visible. Do not invent features; calling a slender face "통통한" means you have no evidence.
12. Never guess the person's identity or name any real person.

Output exactly one JSON object, nothing else. No scores.
{"traits":{"hair":"...","eyes":"...","face":"...","accessory":"...","colors":"..."},"traitsKo":"...","picks":[{"name":"Riolu","match":["hair","colors"],"reason":"..."},{"name":"Zorua","match":["eyes","face","colors"],"reason":"..."}]}`;


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
  const add = (name: string | undefined, slug: string) => {
    if (!name) return;
    const key = nameKey(name);
    // First writer wins, so a base form claims the bare name ahead of a
    // regional variant that normalizes to the same thing.
    if (key && !index.has(key)) index.set(key, slug);
  };
  for (const c of candidates) {
    for (const name of [c.nameEn, c.nameKo, c.slug]) add(name, c.slug);
  }
  // SECOND PASS, so every exact name is claimed first. Models write the
  // species, not the form: "Lycanroc", never "Lycanroc (Midday)". A form only
  // answers to the bare name when no species owns it outright.
  for (const c of candidates) {
    for (const name of [c.nameEn, c.nameKo]) {
      const base = name?.replace(/\s*[({[].*$/, "").trim();
      if (base && base !== name) add(base, c.slug);
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
  // An opened-but-never-closed think block means the budget ran out mid-thought
  // and no answer was ever written. Same fix as empty_content — more budget —
  // so it gets its own name rather than looking like malformed output.
  if (/<think>/.test(content) && !/<\/think>/.test(content)) return "thinking_never_finished";
  if (parsed === null || parsed === undefined) {
    return `unparsed:${content.trim().replace(/\s+/g, " ").slice(-240)}`; // the TAIL: where malformed JSON breaks (2026-11-17: a 71-token answer cut at 80 chars showed only the healthy start)
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

/** The items the model returned, whatever shape it used. */
function pickList(raw: unknown): unknown[] {
  return Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { picks?: unknown })?.picks)
    ? (raw as { picks: unknown[] }).picks
    : [];
}

/** One item -> the slug it refers to, or "" if it refers to nothing we can
 * show. Shared by normalizePicks and unresolvedNames so the two can never
 * disagree about what counts as resolvable. */
function resolveItem(
  item: unknown,
  candidates: CandidateInput[],
  bySlug: Map<string, CandidateInput>,
  byName: Map<string, string>
): { slug: string; named: string; reason: string } {
  if (typeof item === "number" || typeof item === "string") {
    const n = Number(item);
    if (Number.isInteger(n)) {
      return { slug: candidates[n - 1]?.slug ?? "", named: String(item), reason: "" };
    }
    const s = String(item).trim();
    const slug = bySlug.has(s.toLowerCase()) ? s.toLowerCase() : byName.get(nameKey(s)) ?? "";
    return { slug, named: s, reason: "" };
  }
  if (!item || typeof item !== "object") return { slug: "", named: "", reason: "" };

  const p = item as Record<string, unknown>;
  const reason = typeof p.reason === "string" ? sanitizeReason(p.reason) : "";
  const n = Number(p.n ?? p.number ?? p.index);
  if (Number.isInteger(n) && n >= 1 && n <= candidates.length) {
    return { slug: candidates[n - 1].slug, named: String(n), reason };
  }
  if (typeof p.slug === "string" && bySlug.has(p.slug.trim().toLowerCase())) {
    return { slug: p.slug.trim().toLowerCase(), named: p.slug, reason };
  }
  // The model answers with NAMES, since listing 291 candidates cost ~1,050
  // tokens. Anything it names that isn't in the pool doesn't resolve.
  const named = p.name ?? p.pokemon ?? p.slug;
  if (typeof named === "string") {
    return { slug: byName.get(nameKey(named)) ?? "", named, reason };
  }
  return { slug: "", named: "", reason };
}

export function normalizePicks(raw: unknown, candidates: CandidateInput[]): Pick[] {
  const bySlug = new Map(candidates.map((c) => [c.slug, c]));
  const byName = buildNameIndex(candidates);
  const picks: Pick[] = [];
  const used = new Set<string>();

  for (const item of pickList(raw)) {
    const { slug, reason } = resolveItem(item, candidates, bySlug, byName);
    if (!slug || used.has(slug)) continue;
    used.add(slug);
    const match =
      item && typeof item === "object" ? parseMatch((item as { match?: unknown }).match) : undefined;
    picks.push(match ? { slug, reason, match } : { slug, reason });
    if (picks.length >= REQUEST_PICK_COUNT) break;
  }

  return picks;
}

/**
 * The species the model named that we refused to show.
 *
 * ⚠️ Dropping these used to be SILENT, which made a short result unreadable:
 * eight picks arriving and one being displayed looks identical to the model
 * only returning one. The two need opposite fixes — widen what's accepted, or
 * ask the model for more — so the names travel back to ?debug.
 *
 * Sanitized the same way describeUnusable does, since this reaches the browser.
 */
export function unresolvedNames(raw: unknown, candidates: CandidateInput[]): string[] {
  const bySlug = new Map(candidates.map((c) => [c.slug, c]));
  const byName = buildNameIndex(candidates);
  const out: string[] = [];
  for (const item of pickList(raw)) {
    const { slug, named } = resolveItem(item, candidates, bySlug, byName);
    if (slug || !named) continue;
    const clean = named.replace(/[^A-Za-z0-9 .'-]/g, "").trim().slice(0, 24);
    if (clean) out.push(clean);
  }
  return out.slice(0, 12);
}


/**
 * The traits the model committed to before picking (rule 7c), for ?debug and
 * as context for the rerank pass. English, short, and stripped to plain text
 * since it travels back to the browser and into a second prompt.
 */
export function extractTraits(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const t = (raw as { traits?: unknown }).traits;
  let text = "";
  if (Array.isArray(t)) text = t.join(", ");
  else if (typeof t === "string") text = t;
  else if (t && typeof t === "object") {
    // The slot object from rule 7c. "none" slots (no glasses) are dropped.
    text = Object.entries(t as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" && v.trim() && !/^(none|neutral)$/i.test(v.trim()))
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
  }
  return text.replace(/[^A-Za-z0-9 ,.'/:;-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

// ─── Stage 2: visual rerank ────────────────────────────────────────────────
//
// ⚠️ WHY A SECOND PASS EXISTS (2026-11-17 remaster, user: "더 얼굴과 비슷한 포켓몬")
//
// Stage 1 names species from MEMORY. The model sees the face but has to recall
// what each Pokemon looks like, and its ranking among the many species that
// fit "dark hair, sharp eyes" is close to a coin flip (three scans of one face
// once gave 15 different species with zero repeats). That is the weak link.
//
// Stage 2 removes the recall step: the client draws ONE contact sheet — the
// face on the left, the stage-1 picks' official artwork in numbered panels on
// the right — and the model ranks the panels by how much the person actually
// resembles each one, side by side. Comparing two pictures is the thing a
// vision model is genuinely good at; remembering 1,000 designs is not.
//
// One composite image, not nine: this endpoint charges images a flat fee
// regardless of pixel size (measured: 448px and 256px both cost exactly the
// same), so a single wide sheet costs one image. That keeps scan + rerank
// inside one key's 8K-per-minute budget.
//
// Only the ORDER (and fresh, comparison-grounded reasons) come back. Species
// identity is fixed by the panel numbers, so the rerank cannot introduce a
// species — it can only re-sort what stage 1 already resolved.

export const RERANK_MIN = 2;
export const RERANK_MAX = REQUEST_PICK_COUNT;

/** ⚠️ English for the same tokenizer reason as SYSTEM_PROMPT. */
export function buildRerankSystemPrompt(count: number): string {
  return `You judge a "which Pokemon do you look like" service. The image is a contact sheet: the LEFT square is a real person's face; the panels on the RIGHT show ${count} Pokemon, each with its number in the corner.

Grade EVERY numbered Pokemon against the person, comparing the pictures directly. Grade each panel on its own merits — never let its number or position influence the grade.

Per-feature grades, 0-3 (0 = nothing in common, 1 = slight, 2 = clear, 3 = striking):
- "hair": hairstyle and hair colour vs the Pokemon's ears, crest, head shape, fur on the head
- "eyes": eye shape and eyebrows
- "face": face/head silhouette and proportions (long, oval, round, angular)
- "colors": the person's hair and skin colours vs the Pokemon's palette
- "mouth": the person's mouth shape and expression (a wide smile, raised cheeks, a pout) vs the Pokemon's mouth and expression; null if the person's expression is neutral
- "accessory": glasses or other accessories vs eye rings, goggle-like markings, patches around the eyes; null if the person wears none
Then "overall", 0-10: at a glance, how much does this person look like this Pokemon AS A WHOLE? Be strict — one striking shared feature with everything else different is a 3 or 4, not an 8. Mood barely counts: a calm face fits almost anyone. A distinctive expression is graded under "mouth", not here.

For each, "reason": ONE Korean sentence (at most 35 characters) naming the features that graded highest. A mood-only reason is not allowed. Never write any Pokemon name. Never judge the person's body or looks negatively — the words "통통한", "뚱뚱한", "넓은 코", "어색한", "이상한", "못생긴" are forbidden. Never guess who the person is.

Output exactly one JSON object covering all ${count} panels, nothing else:
{"scores":[{"n":1,"hair":2,"eyes":1,"face":0,"mouth":null,"colors":2,"accessory":null,"overall":5,"reason":"..."}]}`;
}

export function buildRerankMessages(sheetDataUrl: string, count: number, traits = "") {
  const hint = traits ? `
An earlier look at this face noted: ${traits}. Use it only if the picture agrees.` : "";
  return [
    { role: "system", content: buildRerankSystemPrompt(count) },
    {
      role: "user",
      content: [
        { type: "text", text: `Grade panels 1-${count} against the face.${hint}` },
        { type: "image_url", image_url: { url: sheetDataUrl } },
      ],
    },
  ];
}

export interface RerankEntry {
  /** 1-based panel number. */
  n: number;
  reason: string;
  /** Combined rubric score (rubricScore), when the model graded this panel. */
  score?: number;
  /** Compact grades for ?debug, e.g. "h2 e1 f0 c2 a- o5". */
  grades?: string;
}

export interface RubricGrades {
  hair: number;
  eyes: number;
  face: number;
  colors: number;
  /** null when the person's expression is neutral — a calm face says nothing
   * about any species, so the slot doesn't exist rather than scoring 0. A
   * DISTINCTIVE expression (a wide smile) is often exactly what a lookalike
   * rests on, which is why it is a slot at all (2026-11-17: a smiling face
   * widely said to resemble a starter got nothing near one, because the only
   * expression rule was "mood barely counts"). Optional so older callers and
   * answers without it still type-check. */
  mouth?: number | null;
  /** null when the person wears no accessory — the slot doesn't exist. */
  accessory: number | null;
  overall: number;
}

/** Subtracted when fewer than two features grade "clear" (≥2). */
export const SINGLE_FEATURE_PENALTY = 4;

/**
 * The displayed "닮은 정도 %" for a graded pick, from its rubric score.
 *
 * Replaces the embedding-z percent for graded picks: the z measures what the
 * local encoder thinks, which is not what decided the order, so the number
 * next to a species disagreed with its rank (and the old forced-descending
 * fix-up turned it into a mechanical 92/90/88/86/84). The rubric score is
 * what actually ranked the pick. A score of 18 (e.g. overall 7, four features
 * at 2-3) reads as 95%; 0 or below reads as 55%.
 */
export function rubricPercent(score: number): number {
  const t = Math.min(1, Math.max(0, score / 18));
  return Math.round(55 + 40 * t);
}

/**
 * One number per panel from the graded rubric:
 *   overall (0-10, holistic) + Σ feature grades (0-3 each) − penalty when fewer
 *   than two features are clearly shared.
 *
 * ⚠️ WHY HYBRID, NOT JUST A SUM (2026-11-17): the failure being fixed is
 * "one feature → one species" (glasses → anything with eye rings). Two
 * findings shaped the formula:
 *   - Decomposed, per-criterion grading tends to track expert judgement better
 *     than a single holistic ranking (CheckEval; DeCE, arXiv 2509.16093), so
 *     each feature is graded on its own and the COMBINING happens here, in
 *     code, where it is visible and testable — not inside the model's head.
 *   - But summed attributes alone don't track perceived lookalikeness either
 *     ("Finding your Lookalike", arXiv 1806.05252), and holistic judges catch
 *     what checklists miss. So the holistic "overall" stays in, at a weight
 *     comparable to the whole feature sum.
 * The penalty is what targets the reported failure: a single striking feature
 * (3) with nothing else always ranks below two clearly shared ones (2 + 2).
 */
export function rubricScore(g: RubricGrades): number {
  const features = [
    g.hair,
    g.eyes,
    g.face,
    g.colors,
    ...(g.mouth === null || g.mouth === undefined ? [] : [g.mouth]),
    ...(g.accessory === null ? [] : [g.accessory]),
  ];
  const sum = features.reduce((x, y) => x + y, 0);
  const breadth = features.filter((v) => v >= 2).length;
  return g.overall + sum - (breadth < 2 ? SINGLE_FEATURE_PENALTY : 0);
}

function grade(v: unknown, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
}

/** Grades from one rerank item, or null when it carries none (a legacy
 * "order" answer), in which case the model's listed order is used as-is. */
function parseGrades(o: Record<string, unknown>): RubricGrades | null {
  if (o.overall === undefined && o.hair === undefined && o.eyes === undefined) return null;
  return {
    hair: grade(o.hair, 3),
    eyes: grade(o.eyes, 3),
    face: grade(o.face, 3),
    colors: grade(o.colors ?? o.color, 3),
    mouth: o.mouth === null || o.mouth === undefined ? null : grade(o.mouth, 3),
    accessory: o.accessory === null || o.accessory === undefined ? null : grade(o.accessory, 3),
    overall: grade(o.overall, 10),
  };
}

/**
 * The model's ranking as a COMPLETE permutation of 1..count.
 *
 * Out-of-range and duplicate numbers are dropped; any panel the model left out
 * is appended in its original (stage-1) order with an empty reason. Returns []
 * when the model ranked nothing at all, so the caller keeps stage 1 untouched
 * instead of applying a "ranking" that is really just the original order.
 */
export function normalizeRerank(raw: unknown, count: number): RerankEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { scores?: unknown })?.scores)
    ? (raw as { scores: unknown[] }).scores
    : Array.isArray((raw as { order?: unknown })?.order)
    ? (raw as { order: unknown[] }).order
    : Array.isArray((raw as { picks?: unknown })?.picks)
    ? (raw as { picks: unknown[] }).picks
    : [];
  const out: RerankEntry[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    let n = NaN;
    let reason = "";
    let g: RubricGrades | null = null;
    if (typeof item === "number" || typeof item === "string") n = Number(item);
    else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      n = Number(o.n ?? o.number ?? o.panel ?? o.index);
      if (typeof o.reason === "string") reason = sanitizeReason(o.reason);
      g = parseGrades(o);
    }
    if (!Number.isInteger(n) || n < 1 || n > count || seen.has(n)) continue;
    seen.add(n);
    out.push(
      g
        ? {
            n,
            reason,
            score: rubricScore(g),
            grades:
              `h${g.hair} e${g.eyes} f${g.face} c${g.colors} ` +
              `m${g.mouth === null || g.mouth === undefined ? "-" : g.mouth} ` +
              `a${g.accessory === null ? "-" : g.accessory} o${g.overall}`,
          }
        : { n, reason }
    );
  }
  if (out.length === 0) return [];
  // Graded answers are ORDERED BY THE COMBINED SCORE, not by the order the
  // model happened to list them in — that is the point of grading. Ties keep
  // the listed order (sort is stable). Ungraded panels sink below graded ones.
  if (out.some((e) => e.score !== undefined)) {
    out.sort((x, y) => (y.score ?? -Infinity) - (x.score ?? -Infinity));
  }
  for (let n = 1; n <= count; n++) if (!seen.has(n)) out.push({ n, reason: "" });
  return out;
}

// ─── Model selection ───────────────────────────────────────────────────────
//
// ⚠️⚠️ WHY THIS EXISTS (2026-11-17): Groq retired `qwen/qwen3.6-27b` on
// 2026-09-14. From that day EVERY judge request failed and every scan quietly
// fell back to the local ranker. Users saw "AI가 고른 결과가 아니에요" over and
// over, and nothing said why, because a non-429 upstream error was reported as
// a bare "judge_unavailable".
//
// Two defences:
//   1. A model ID we KNOW is retired, or that can't see images, is replaced
//      with the current default even when an env var pins it. GROQ_MODEL set
//      once in Vercel would otherwise keep the feature dead after the code
//      moved on. (Every model on this list fails 100% of requests here, so
//      overriding the operator's choice can only help.)
//   2. upstreamErrorCode puts Groq's own error code (model_decommissioned,
//      model_not_found, invalid_api_key …) into ?debug, so the next retirement
//      is diagnosed in one scan instead of two months.
//
// Groq's vision lineup is all Preview (no production vision model as of
// 2026-11): qwen/qwen3.8-27b and an enterprise-only Muse model. Preview models
// get retired, so expect to edit this again — check
// https://console.groq.com/docs/deprecations when ?debug shows
// "model_decommissioned" or "model_not_found".

export const DEFAULT_JUDGE_MODEL = "qwen/qwen3.8-27b";

/** Model IDs this endpoint must never send to. Retired ones answer with an
 * error; text-only ones reject the image. */
export const UNUSABLE_JUDGE_MODELS: Record<string, string> = {
  "qwen/qwen3.6-27b": "retired 2026-09-14",
  "meta-llama/llama-4-scout-17b-16e-instruct": "retired",
  "meta-llama/llama-4-maverick-17b-128e-instruct": "retired",
  "openai/gpt-oss-120b": "text-only",
  "openai/gpt-oss-20b": "text-only",
  "llama-3.3-70b-versatile": "text-only",
  "llama-3.1-8b-instant": "text-only",
};

/** The configured model, or the default when it is unset or known-unusable. */
export function resolveJudgeModel(configured: string | undefined): string {
  const id = configured?.trim();
  if (!id || UNUSABLE_JUDGE_MODELS[id]) return DEFAULT_JUDGE_MODEL;
  return id;
}

/**
 * HTTP status plus the provider's error code, from an OpenAI-style error body
 * ({"error":{"code":"model_decommissioned","type":…,"message":…}}). Only the
 * short machine code is kept — the message can echo request details or the
 * organization, and this string reaches the browser.
 */
export function upstreamErrorCode(status: number, body: string): string {
  let code = "";
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
    const raw = parsed?.error?.code ?? parsed?.error?.type;
    if (typeof raw === "string") code = raw;
  } catch {
    // not JSON
  }
  code = code.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
  return code ? `upstream_${status}:${code}` : `upstream_${status}`;
}


/**
 * True when a Korean reason names something you can point at in the photo —
 * hair, glasses, eyes, face shape, colour — rather than only a mood.
 *
 * ⚠️ WHY (2026-11-17, real scan): a face with square glasses and dark straight
 * bangs came back with five reasons that were all one observation reworded —
 * "고요한 눈매", "차분한 이미지", "차분한 눈빛", "평온하고 고요한 분위기",
 * "차분하고 단정한 인상" — and none mentioned the glasses or the bangs. A calm
 * neutral expression is in almost every selfie, so a mood-only reason says
 * nothing about THIS face, and the species chosen on it (Mudkip, Slowpoke,
 * Snorlax) were chosen on nothing. The bigram-overlap guard didn't catch it
 * because the wording varied.
 *
 * Used to PREFER a feature-based reason, never to delete a pick: see
 * pickReason in llmJudge.ts. "눈빛" deliberately doesn't count — it is mood
 * expressed through the eyes, not the eyes' shape.
 */
const VISIBLE_FEATURE_RE =
  /(앞머리|머리카락|머리색|머릿결|헤어|가르마|곱슬|직모|단발|머리|안경|안경테|렌즈|눈매|눈꼬리|눈썹|쌍꺼풀|눈 모양|눈동자|큰 눈|얼굴형|얼굴선|얼굴 윤곽|갸름|둥근 얼굴|긴 얼굴|각진|턱|광대|이마|콧대|코끝|입술|입매|입꼬리|미소|웃는|웃음|보조개|입 모양|볼|피부|색감|색깔|빛깔|검은|갈색|하얀|밝은 색|어두운 색|귀|무늬|테두리)/;

export function hasVisibleFeature(reason: string): boolean {
  return VISIBLE_FEATURE_RE.test(reason.replace(/눈빛/g, ""));
}


/**
 * The Korean version of the traits, shown to the user as "AI가 본 내 얼굴".
 * Same filter as a reason (no latin, nothing demeaning), plus a hard length
 * cap; "" when it doesn't survive, and the UI then shows nothing.
 *
 * Why show it at all: the five species only make sense against what the model
 * saw. A result that says "검은 일자 앞머리 · 사각 안경" above Riolu and Pancham
 * reads as a judgement; the same five without it read as a lottery.
 */
export function extractTraitsKo(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const t = (raw as { traitsKo?: unknown }).traitsKo;
  const text = Array.isArray(t) ? t.join(" · ") : typeof t === "string" ? t : "";
  const clean = sanitizeReason(text.replace(/\s+/g, " "));
  return clean.length <= 40 ? clean : "";
}
