// The 40 species PokéMatch prefers to hand back as a "you look like this" result.
//
// Why a curated pool at all: the fun of this app depends on RECOGNITION. Being
// told you resemble a species nobody can picture isn't a result, it's a shrug —
// and the embedding shortlist, left alone, surfaces plenty of those. So the
// judge picks from this list first and only reaches outside it when a wildcard
// is clearly a better match (see the prompt in judgeProtocol.ts).
//
// This does NOT make the result the same for everyone: each entry is still
// scored against the individual's own embedding (matcher.scoreSlugs), so the
// z-values the judge sees differ per face. The pool fixes WHICH pokemon can
// win, not WHO wins.
//
// Selection criteria, in order:
//   1. Recognizable — gen 1/2 heavy, plus later species that are genuinely famous.
//   2. Has a readable face with a distinct impression.
//   3. Spread across impressions, so different faces land on different results.
//      Grouped below so the coverage stays auditable when editing.
//   4. Not an insult. Deliberately excluded: Muk/Grimer/Garbodor (filth),
//      Snorlax/Slowpoke (fat and slow jokes), Magikarp (useless), Hypno
//      (creepy). Somebody's face is the input — the output has to be something
//      they'd enjoy being shown.
//
// `look` gives the judge a visual vocabulary to match the measured face
// descriptors against. The model is text-only and never sees the sprite, so
// without this it can only lean on whatever it happens to remember about each
// species' appearance. Keep these about the FACE and the IMPRESSION.

export interface CuratedEntry {
  slug: string;
  look: string;
}

export const CURATED_POOL: CuratedEntry[] = [
  // ── 날카롭고 서늘한 인상 ──────────────────────────────────────────────
  { slug: "lucario", look: "또렷한 이목구비에 눈매가 곧고 날카로움, 단단하고 강직한 인상" },
  { slug: "gengar", look: "동그란 윤곽에 장난기 어린 큰 미소, 눈이 가늘고 짓궂음" },
  { slug: "absol", look: "갸름하고 서늘한 얼굴, 눈꼬리가 크게 올라간 냉정한 인상" },
  { slug: "zoroark", look: "길고 좁은 얼굴에 눈매가 사납고 강렬함, 풍성한 머리" },
  { slug: "weavile", look: "뾰족한 턱과 치켜올라간 눈, 얄미울 만큼 영리해 보이는 인상" },
  { slug: "houndoom", look: "길쭉한 주둥이와 붉은 눈, 어둡고 카리스마 있는 인상" },
  { slug: "greninja", look: "좁고 긴 얼굴에 무표정하고 침착함, 눈매가 가늘고 길다" },
  { slug: "mewtwo", look: "갸름한 역삼각 얼굴에 큰 보라색 눈, 서늘하고 압도적인 인상" },

  // ── 우아하고 단정한 인상 ──────────────────────────────────────────────
  { slug: "gardevoir", look: "작고 갸름한 얼굴에 큰 눈, 차분하고 우아한 인상" },
  { slug: "ninetales", look: "가늘고 길게 째진 눈, 도도하고 기품 있는 인상" },
  { slug: "sylveon", look: "둥글고 부드러운 얼굴에 큰 눈, 다정하고 사랑스러운 인상" },
  { slug: "espeon", look: "가름한 얼굴에 크고 또렷한 눈, 우아하고 신비로운 인상" },
  { slug: "primarina", look: "이목구비가 또렷하고 단정함, 무대에 선 듯 우아한 인상" },
  { slug: "froslass", look: "창백하고 갸름한 얼굴, 조용하고 서늘하게 아름다운 인상" },

  // ── 밝고 귀여운 인상 ─────────────────────────────────────────────────
  { slug: "pikachu", look: "동그란 얼굴에 볼이 도톰하고 눈이 크고 까맣다, 밝고 친근함" },
  { slug: "eevee", look: "둥근 얼굴에 큰 눈망울, 순하고 다정한 인상" },
  { slug: "vulpix", look: "작고 동그란 얼굴에 눈이 크다, 앙증맞고 새침한 인상" },
  { slug: "growlithe", look: "둥글고 복슬복슬한 얼굴, 씩씩하고 사람 좋아 보이는 인상" },
  { slug: "mimikyu", look: "둥근 실루엣에 어설픈 표정, 엉뚱하고 애틋한 인상" },
  { slug: "togekiss", look: "둥글고 하얀 얼굴에 순한 눈, 온화하고 복스러운 인상" },
  { slug: "piplup", look: "동그란 머리에 또렷한 눈, 도도하면서도 귀여운 인상" },
  { slug: "cyndaquil", look: "눈을 가늘게 뜬 편안한 표정, 수줍고 순한 인상" },

  // ── 차분하고 지적인 인상 ──────────────────────────────────────────────
  { slug: "alakazam", look: "길쭉한 얼굴에 콧수염, 눈이 가늘고 사색적인 인상" },
  { slug: "meowstic", look: "가름한 얼굴에 무표정한 큰 눈, 조용하고 도도한 인상" },
  { slug: "inteleon", look: "매우 길고 좁은 얼굴에 가늘게 뜬 눈, 시크하고 침착한 인상" },
  { slug: "delphox", look: "길쭉한 얼굴에 차분한 눈매, 사려 깊고 우아한 인상" },
  { slug: "oranguru", look: "넓적한 얼굴에 진중한 눈, 어른스럽고 느긋한 인상" },

  // ── 듬직하고 강인한 인상 ──────────────────────────────────────────────
  { slug: "arcanine", look: "넓고 당당한 얼굴, 늠름하고 믿음직한 인상" },
  { slug: "charizard", look: "길쭉한 주둥이에 눈매가 강하다, 자신감 넘치는 인상" },
  { slug: "blaziken", look: "날렵하고 각진 얼굴에 형형한 눈, 열정적이고 단단한 인상" },
  { slug: "infernape", look: "동그란 얼굴에 활발한 표정, 장난기와 승부욕이 함께 보이는 인상" },
  { slug: "tyranitar", look: "각지고 넓은 턱, 묵직하고 든든한 인상" },
  { slug: "machamp", look: "각진 얼굴에 다부진 턱선, 우직하고 힘 있는 인상" },

  // ── 개성 있고 장난기 있는 인상 ─────────────────────────────────────────
  { slug: "meowth", look: "동그란 얼굴에 웃는 눈, 능글맞고 넉살 좋은 인상" },
  { slug: "sneasel", look: "작고 뾰족한 얼굴에 치켜뜬 눈, 새침하고 날렵한 인상" },
  { slug: "rotom", look: "동그란 윤곽에 익살스러운 표정, 엉뚱하고 발랄한 인상" },
  { slug: "pangoro", look: "넓적한 얼굴에 험상궂은 눈매, 무뚝뚝하지만 의리 있는 인상" },
  { slug: "obstagoon", look: "길고 각진 얼굴에 강렬한 흑백 무늬, 반항적이고 개성 강한 인상" },
  { slug: "scrafty", look: "턱이 넓고 눈매가 사납다, 껄렁하지만 미워할 수 없는 인상" },
  { slug: "umbreon", look: "매끈하고 갸름한 얼굴에 붉은 눈, 차분하고 시크한 인상" },
];

export const CURATED_SLUGS: string[] = CURATED_POOL.map((e) => e.slug);

const LOOK_BY_SLUG = new Map(CURATED_POOL.map((e) => [e.slug, e.look]));

export function lookFor(slug: string): string | undefined {
  return LOOK_BY_SLUG.get(slug);
}

export function isCurated(slug: string): boolean {
  return LOOK_BY_SLUG.has(slug);
}
