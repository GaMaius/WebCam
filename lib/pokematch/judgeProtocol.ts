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
5. Each reason must cite a DIFFERENT feature. Do not reword one observation (e.g. "big eyes", "calm mood") over and over — that is making one pick repeatedly, not several. Spread across hairstyle and hair colour, glasses or other accessories, eye shape, eyebrows, face shape, jawline, skin tone.
5a. Start from what is MOST visible: hairstyle (bangs, parting, colour), glasses, eye shape, face shape. Glasses are a real feature — Pokemon with eye rings, goggle-like markings or dark patches around the eyes echo them. A calm or neutral expression is common to almost every photo, so it is never enough on its own to choose a species.
7. Different people must get different results. Base the choice on what is specific to THIS face.
7c. Commit to the answer. FIRST write "traits": the two or three most distinctive features of this face, in a few English words (e.g. "sharp upturned eyes, dark messy hair, narrow jaw"). THEN pick species that match THOSE traits. Shown the same photo again you should reach the same traits and the same conclusion — if several species feel equally fine, you have not narrowed it down yet.
7d. Match the whole impression, not one feature. A good pick resembles the face in silhouette, eye shape AND colouring/mood together; a species that shares only one feature is a weak pick.
7a. ⚠️ DO NOT DEFAULT TO FAMOUS MASCOTS. Pikachu, Psyduck, Clefairy, Togepi, Eevee and similar household-name cute species are the lazy answer and they fit almost anybody, which makes them wrong almost every time. Pick one only if this face matches it distinctly better than every alternative.
7b. Let the measured notes steer you where they are decisive. Upturned or sharp eyes suit a sharp-featured species, not a round mascot; a long face suits an elongated design; dark hair suits a dark-coloured species. A round cute species needs a genuinely round soft face to earn the pick.
8. Write each reason as ONE Korean sentence, at most 45 characters, naming at least one CONCRETE visible feature (hair, bangs, glasses, eye shape, eyebrows, face shape, jaw, skin tone). A reason that only describes mood ("차분한 분위기", "고요한 인상") is not allowed. Example: "검은 일자 앞머리와 눈 주위 안경 테가 무늬와 닮았어요"
9. NEVER write a Pokemon name inside the reason — the name is displayed separately, so a name you write will contradict it. Describe only what you see in the face.
10. This is for fun. Write only sentences the reader would enjoy. Never judge body or looks: the words "통통한", "뚱뚱한", "넓은 코", "어색한", "이상한", "못생긴" are forbidden. Use appealing features instead — eyes, impression, mood, hairstyle.
11. Say only what is visible. Do not invent features; calling a slender face "통통한" means you have no evidence.
12. Never guess the person's identity or name any real person.

Output exactly one JSON object, nothing else. No scores.
{"traits":"...","picks":[{"name":"Riolu","reason":"..."},{"name":"Zorua","reason":"..."}]}`;


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
    picks.push({ slug, reason });
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
  const text = Array.isArray(t) ? t.join(", ") : typeof t === "string" ? t : "";
  return text.replace(/[^A-Za-z0-9 ,.'/-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
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

Rank ALL ${count} numbered Pokemon by how much the person resembles each one, most similar first. Compare the pictures directly, side by side:
1. hairstyle and hair colour against the Pokemon's ears, crest, head shape and colours (bangs, parting, length)
2. glasses or accessories against eye rings, goggle-like markings or patches around the eyes
3. face/head silhouette and proportions (long, oval, round, angular)
4. eye shape and eyebrows
5. colour harmony: hair and skin colours against the Pokemon's palette
6. overall mood — LAST, and only as a tie-breaker: a calm or neutral expression fits almost anyone, so it never decides the order by itself
A Pokemon that matches several of 1-5 together beats one that matches a single feature. Ignore pose and background.

For each, write ONE Korean sentence (at most 35 characters) naming a CONCRETE feature the person and that Pokemon visibly share (hair, glasses, eye shape, face shape, colours). A mood-only reason ("차분한 분위기가 닮았다") is not allowed, and each reason must name a different feature. Never write any Pokemon name. Never judge the person's body or looks negatively — the words "통통한", "뚱뚱한", "넓은 코", "어색한", "이상한", "못생긴" are forbidden. Never guess who the person is.

Output exactly one JSON object, nothing else:
{"order":[{"n":3,"reason":"..."},{"n":1,"reason":"..."}]}`;
}

export function buildRerankMessages(sheetDataUrl: string, count: number, traits = "") {
  const hint = traits ? `
An earlier look at this face noted: ${traits}. Use it only if the picture agrees.` : "";
  return [
    { role: "system", content: buildRerankSystemPrompt(count) },
    {
      role: "user",
      content: [
        { type: "text", text: `Rank panels 1-${count} by resemblance to the face, best first.${hint}` },
        { type: "image_url", image_url: { url: sheetDataUrl } },
      ],
    },
  ];
}

export interface RerankEntry {
  /** 1-based panel number. */
  n: number;
  reason: string;
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
    if (typeof item === "number" || typeof item === "string") n = Number(item);
    else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      n = Number(o.n ?? o.number ?? o.panel ?? o.index);
      if (typeof o.reason === "string") reason = sanitizeReason(o.reason);
    }
    if (!Number.isInteger(n) || n < 1 || n > count || seen.has(n)) continue;
    seen.add(n);
    out.push({ n, reason });
  }
  if (out.length === 0) return [];
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
  /(앞머리|머리카락|머리색|머릿결|헤어|가르마|곱슬|직모|단발|머리|안경|안경테|렌즈|눈매|눈꼬리|눈썹|쌍꺼풀|눈 모양|눈동자|큰 눈|얼굴형|얼굴선|얼굴 윤곽|갸름|둥근 얼굴|긴 얼굴|각진|턱|광대|이마|콧대|코끝|입술|입매|입꼬리|볼|피부|색감|색깔|빛깔|검은|갈색|하얀|밝은 색|어두운 색|귀|무늬|테두리)/;

export function hasVisibleFeature(reason: string): boolean {
  return VISIBLE_FEATURE_RE.test(reason.replace(/눈빛/g, ""));
}
