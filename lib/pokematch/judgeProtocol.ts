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
}

export interface Pick {
  slug: string;
  percent: number;
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
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export const SYSTEM_PROMPT = `당신은 "닮은 포켓몬 찾기" 서비스의 심사위원입니다.
사용자의 얼굴을 실제로 측정한 수치 설명과, 이미지 임베딩이 뽑아준 후보 포켓몬 목록을 받습니다.
당신은 사진을 볼 수 없습니다. 오직 주어진 수치 설명만으로 판단하세요.

판정 규칙:
1. 반드시 주어진 후보 목록 안에서만 고르세요. 목록에 없는 slug는 절대 만들어내지 마세요.
2. 정확히 ${PICK_COUNT}마리를 닮은 순서대로 고르세요.
3. 후보에 붙은 유사도(z) 점수는 "이미지가 비슷해 보인다"는 약한 참고값일 뿐입니다. 얼굴 수치 설명과 실제 포켓몬의 생김새(얼굴형, 눈매, 색, 실루엣, 분위기)가 맞는지를 우선하세요. z가 높아도 얼굴 특징과 어긋나면 과감히 버리세요.
4. 5마리가 같은 진화 계열이거나 서로 거의 똑같이 생기면 안 됩니다. 서로 다른 인상의 포켓몬으로 채우세요.
5. percent는 55~97 사이 정수이며, 1위부터 5위까지 반드시 내림차순이고 서로 다른 값이어야 합니다.
6. reason은 한국어 한 문장(공백 포함 60자 이내)이고, 반드시 주어진 얼굴 수치 중 구체적인 근거 하나 이상을 언급해야 합니다. (예: "턱각이 크고 눈매가 올라가 있어 ~와 겹칩니다")
7. 재미로 보는 서비스입니다. 외모를 비하하거나 평가절하하는 표현은 쓰지 마세요.

출력은 오직 아래 형태의 JSON 하나입니다. 다른 텍스트를 덧붙이지 마세요.
{"picks":[{"slug":"pikachu","percent":93,"reason":"..."}]}`;

export function buildUserPrompt(description: string, candidates: CandidateInput[]): string {
  const lines = candidates.map((c) => {
    const name = c.nameKo ?? c.nameEn ?? c.slug;
    const bits = [
      `slug=${c.slug}`,
      `이름=${name}${c.nameEn && c.nameKo ? `(${c.nameEn})` : ""}`,
      c.types?.length ? `타입=${c.types.join("/")}` : null,
      c.color ? `대표색=${c.color}` : null,
      c.shape ? `형태=${c.shape}` : null,
      c.z !== undefined ? `z=${c.z}` : null,
    ].filter(Boolean);
    return `- ${bits.join(", ")}`;
  });

  return `[사용자 얼굴 측정값]
${description.slice(0, MAX_DESCRIPTION_CHARS)}

[후보 포켓몬 ${candidates.length}종 — 이 중에서만 고르세요]
${lines.join("\n")}`;
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
 * Turns the model's output into picks we can actually render. Every rule the
 * prompt states is re-enforced here — a slug outside the shortlist has no
 * image or pokedex entry, and a non-descending percent list reads as a bug to
 * the user, so neither is left to the model's compliance.
 */
export function normalizePicks(raw: unknown, allowed: Set<string>): Pick[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { picks?: unknown })?.picks)
    ? (raw as { picks: unknown[] }).picks
    : [];

  const picks: Pick[] = [];
  const used = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const slug = typeof p.slug === "string" ? p.slug.trim().toLowerCase() : "";
    if (!allowed.has(slug) || used.has(slug)) continue;
    used.add(slug);
    const percentRaw = typeof p.percent === "number" ? p.percent : Number(p.percent);
    const percent = Number.isFinite(percentRaw) ? Math.round(percentRaw) : 80;
    picks.push({
      slug,
      percent: Math.max(50, Math.min(99, percent)),
      reason: typeof p.reason === "string" ? p.reason.trim().slice(0, 120) : "",
    });
    if (picks.length >= PICK_COUNT) break;
  }

  for (let i = 1; i < picks.length; i++) {
    if (picks[i].percent >= picks[i - 1].percent) {
      picks[i].percent = Math.max(50, picks[i - 1].percent - 3);
    }
  }
  return picks;
}
