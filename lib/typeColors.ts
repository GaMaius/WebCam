// Official-ish Pokémon type colors, keyed by Korean type label (matches
// pokedex.json typesKo). `fg` is the readable text color on that background.
export const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  노말: { bg: "#A8A77A", fg: "#1c1f15" },
  불꽃: { bg: "#EE8130", fg: "#fff" },
  물: { bg: "#6390F0", fg: "#fff" },
  풀: { bg: "#7AC74C", fg: "#12300a" },
  전기: { bg: "#F7D02C", fg: "#1c1f15" },
  얼음: { bg: "#96D9D6", fg: "#0f2a29" },
  격투: { bg: "#C22E28", fg: "#fff" },
  독: { bg: "#A33EA1", fg: "#fff" },
  땅: { bg: "#E2BF65", fg: "#1c1f15" },
  비행: { bg: "#A98FF3", fg: "#1a1030" },
  에스퍼: { bg: "#F95587", fg: "#fff" },
  벌레: { bg: "#A6B91A", fg: "#161f00" },
  바위: { bg: "#B6A136", fg: "#1c1f15" },
  고스트: { bg: "#735797", fg: "#fff" },
  드래곤: { bg: "#6F35FC", fg: "#fff" },
  악: { bg: "#705746", fg: "#fff" },
  강철: { bg: "#B7B7CE", fg: "#1c1f15" },
  페어리: { bg: "#D685AD", fg: "#2e0f22" },
};

export function typeColor(typeKo: string): { bg: string; fg: string } {
  return TYPE_COLORS[typeKo] ?? { bg: "#8b8a73", fg: "#fff" };
}
