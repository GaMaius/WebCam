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

export const PICK_COUNT = 5;
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

export const SYSTEM_PROMPT = `당신은 "닮은 포켓몬 찾기" 서비스의 심사위원입니다.
사용자의 얼굴 사진을 직접 보고, 주어진 후보 목록에서 가장 닮은 포켓몬을 고릅니다.

판정 규칙:
1. 사진을 직접 보고 판단하세요. 얼굴형, 눈매와 눈 크기, 코와 입, 턱선, 헤어스타일과 머리색, 피부톤, 그리고 전체적인 분위기·인상을 보세요.
2. 후보는 **번호**로 지목하세요. 목록에 있는 번호만 쓰고, 없는 번호는 절대 쓰지 마세요.
3. 정확히 ${PICK_COUNT}마리를 닮은 순서대로 고르세요. 첫 번째가 가장 닮은 것입니다.
4. 5마리가 서로 거의 똑같은 인상이면 안 됩니다. 같은 진화 계열로 채우지 말고, 서로 다른 인상이 섞이게 고르되 1위는 가장 잘 맞는 하나여야 합니다.
5. 사람마다 다른 결과가 나와야 합니다. 무난하고 유명하다는 이유로 아무에게나 어울리는 포켓몬을 고르지 마세요. 이 얼굴에서만 보이는 특징을 근거로 삼으세요.
6. reason은 한국어 한 문장(공백 포함 45자 이내)이고, 사진에서 실제로 보이는 근거를 하나 이상 말해야 합니다. (예: "눈꼬리가 올라가고 턱선이 뚜렷해 잘 맞습니다")
7. **reason에 포켓몬 이름을 쓰지 마세요.** 얼굴에서 보이는 근거만 쓰세요. 이름은 화면에 따로 표시되므로, 당신이 이름을 적으면 표시된 이름과 어긋나 보입니다. ("마릴과 잘 어울립니다" ❌ → "둥근 안경과 부드러운 눈매가 잘 어울립니다" ⭕)
8. 재미로 보는 서비스입니다. 읽는 사람이 기분 좋을 문장만 쓰세요. **체형·외모를 평가하는 표현은 금지**입니다 — "통통한", "뚱뚱한", "넓은 코", "어색한", "이상한", "못생긴" 같은 말은 절대 쓰지 마세요. 대신 눈매·인상·분위기·헤어스타일처럼 호감 가는 특징을 근거로 삼으세요.
9. 사진에 실제로 보이는 것만 말하세요. 보이지 않는 특징을 지어내지 마세요 — 갸름한 얼굴을 "통통하다"고 하는 식의 잘못된 묘사는 근거가 없다는 뜻입니다.
10. 사진 속 인물의 신원을 추측하거나 실존 인물의 이름을 말하지 마세요.

출력은 오직 아래 형태의 JSON 하나입니다. 이름·점수는 쓰지 마세요.
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

export function buildUserPrompt(description: string, candidates: CandidateInput[]): string {
  const sections = [`이 얼굴과 가장 닮은 포켓몬 ${PICK_COUNT}마리를 아래 후보에서 골라주세요.`];
  if (description.trim()) {
    sections.push(
      `[참고용 얼굴 측정값 — 사진이 우선이고, 이건 보조 자료입니다]\n${description.slice(
        0,
        MAX_DESCRIPTION_CHARS
      )}`
    );
  }
  sections.push(`[후보 ${candidates.length}종]\n${buildCandidateList(candidates)}`);
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
    if (picks.length >= PICK_COUNT) break;
  }

  return picks;
}
