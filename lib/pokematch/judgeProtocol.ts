// Pure request/response handling for the PokéMatch judge. Kept out of the
// route handler so it can be tested with `node --test` (the route imports
// next/server, which isn't loadable there) — and because parsing an LLM's
// output is the part most likely to be wrong in a way a build won't catch.

export const PICK_COUNT = 5;
export const MAX_CANDIDATES = 60;
export const MAX_DESCRIPTION_CHARS = 4000;

export interface CandidateInput {
  slug: string;
  nameKo?: string;
  nameEn?: string;
  types?: string[];
  color?: string | null;
  shape?: string | null;
  z?: number;
  /** Short Korean description of the species' face/impression. Only the
   * curated pool carries this — the judge can't see sprites, so for anything
   * else it has to fall back on whatever it remembers. */
  look?: string;
  /** True for the curated "good to show" pool; false for embedding wildcards. */
  curated?: boolean;
}

export interface Pick {
  slug: string;
  reason: string;
}

const SLUG_RE = /^[a-z0-9_-]{1,40}$/;

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
      nameKo: typeof c.nameKo === "string" ? c.nameKo.slice(0, 40) : undefined,
      nameEn: typeof c.nameEn === "string" ? c.nameEn.slice(0, 40) : undefined,
      types: Array.isArray(c.types)
        ? c.types.filter((t): t is string => typeof t === "string").slice(0, 3).map((t) => t.slice(0, 16))
        : undefined,
      color: typeof c.color === "string" ? c.color.slice(0, 16) : null,
      shape: typeof c.shape === "string" ? c.shape.slice(0, 16) : null,
      z: typeof c.z === "number" && Number.isFinite(c.z) ? Number(c.z.toFixed(2)) : undefined,
      look: typeof c.look === "string" ? c.look.slice(0, 80) : undefined,
      curated: c.curated === true,
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export const SYSTEM_PROMPT = `당신은 "닮은 포켓몬 찾기" 서비스의 심사위원입니다.
사용자의 얼굴을 실제로 측정한 수치 설명과, 후보 포켓몬 목록을 받습니다.
당신은 사진을 볼 수 없습니다. 오직 주어진 수치 설명과 후보의 생김새 설명만으로 판단하세요.

후보는 두 그룹입니다:
- [추천 목록] 결과로 보여주기 좋은 포켓몬들입니다. 각 항목에 생김새·인상 설명이 붙어 있습니다. **되도록 여기서 고르세요.**
- [그 외 후보] 이미지 유사도만 높게 나온 종입니다. 추천 목록에 정말 맞는 게 없을 때만, 그리고 명백히 더 닮았을 때만 쓰세요. 최대 1마리까지만 허용합니다.

판정 규칙:
1. 후보는 **번호**로 지목하세요. 목록에 있는 번호만 쓰고, 없는 번호는 절대 쓰지 마세요.
2. 정확히 ${PICK_COUNT}마리를 닮은 순서대로 고르세요. 첫 번째가 가장 닮은 것입니다.
3. 판단의 중심은 **얼굴 수치 설명 ↔ 후보의 생김새 설명**의 일치입니다. 얼굴형·눈매·눈 크기·턱선·인상을 맞춰보세요. 후보에 붙은 유사도(z) 점수는 "이미지가 비슷해 보인다"는 약한 참고값일 뿐이니, z가 높아도 생김새가 어긋나면 과감히 버리세요.
4. 5마리가 서로 거의 똑같은 인상이면 안 됩니다. 날카로운/우아한/귀여운/듬직한/개성 있는 인상이 섞이도록 고르되, 1위는 가장 잘 맞는 하나여야 합니다.
5. reason은 한국어 한 문장(공백 포함 45자 이내)이고, 반드시 주어진 얼굴 수치 중 구체적인 근거 하나 이상을 언급해야 합니다. (예: "턱각이 크고 눈매가 올라가 있어 잘 맞습니다")
6. 재미로 보는 서비스입니다. 외모를 비하하거나 평가절하하는 표현은 절대 쓰지 마세요. 읽는 사람이 기분 좋을 문장으로 쓰세요.

출력은 오직 아래 형태의 JSON 하나입니다. 이름·영문·점수는 쓰지 마세요.
{"picks":[{"n":7,"reason":"..."},{"n":21,"reason":"..."}]}`;

/**
 * One candidate, addressed by NUMBER rather than by slug.
 *
 * The number is the cheapest possible identifier (1-2 tokens against ~6 for an
 * English slug, over ~46 candidates) and it also removes a whole failure mode:
 * the model can't misspell or invent a number that isn't on the list. English
 * text is kept out entirely — the judge never needs the English name, because
 * `look` (not the model's memory of the species) is what it matches against.
 */
function candidateLine(c: CandidateInput, number: number): string {
  const name = c.nameKo ?? c.nameEn ?? c.slug;
  // Curated entries carry a look description, which is the thing worth reading.
  // Wildcards have none, so they fall back to the coarse type/shape hints.
  const detail = c.look
    ? c.look
    : [c.types?.length ? c.types.join("/") : null, c.shape].filter(Boolean).join(" ");
  return `${number}. ${name}${detail ? ` · ${detail}` : ""}${c.z !== undefined ? ` · z=${c.z}` : ""}`;
}

export function buildUserPrompt(description: string, candidates: CandidateInput[]): string {
  // Numbering is global and follows the array order, so the sections below can
  // split the list without the numbers shifting — normalizePicks maps a
  // returned number straight back through this same array.
  const numbered = candidates.map((c, i) => ({ c, n: i + 1 }));
  const curated = numbered.filter(({ c }) => c.curated);
  const wildcards = numbered.filter(({ c }) => !c.curated);

  const sections = [`[사용자 얼굴 측정값]\n${description.slice(0, MAX_DESCRIPTION_CHARS)}`];
  if (curated.length) {
    sections.push(
      `[추천 목록 ${curated.length}종 — 되도록 여기서 고르세요]\n${curated
        .map(({ c, n }) => candidateLine(c, n))
        .join("\n")}`
    );
  }
  if (wildcards.length) {
    sections.push(
      `[그 외 후보 ${wildcards.length}종 — 정말 더 닮았을 때만, 최대 1마리]\n${wildcards
        .map(({ c, n }) => candidateLine(c, n))
        .join("\n")}`
    );
  }
  return sections.join("\n\n");
}

/** gpt-oss emits reasoning, and json_object mode isn't guaranteed if the
 * model config rejects it, so accept fenced, prefixed and prose-wrapped JSON. */
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
      if (typeof p.reason === "string") reason = p.reason.trim().slice(0, 120);
    }

    if (!slug || used.has(slug)) continue;
    used.add(slug);
    picks.push({ slug, reason });
    if (picks.length >= PICK_COUNT) break;
  }

  return picks;
}
