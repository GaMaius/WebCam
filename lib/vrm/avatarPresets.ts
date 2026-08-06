// Built-in avatars offered in the VrmMotion picker.
//
// The FBX preset needs a texture table because the raw download's FBX contains
// NO texture references at all (verified by scanning the binary — the loader
// requests zero texture URLs), while the maps ship as a separate folder whose
// filenames only carry an index suffix. So material -> map is a convention, not
// data, and lives here where it's easy to correct.
//
// Suit is well-founded: materials are literally named "1".."5" and map to
// Suit_*.1001..1005 (and the red/blue split of those tiles matches the suit).
// The accessory assignment is inferred: `Lense` gets Acc_*.1011 because that's
// the only bright, detailed tile (mean 155 vs 1-25 for the others) and the eye
// lenses are the white part; the rest take the remaining tiles in order. If a
// part looks wrong, swap its tile here — nothing else depends on it.
//
// The `Webs` material (web-pattern overlay on the suit mesh) has no rule because
// the download ships no tile for it — it renders in the FBX's own flat color.
// `scratch/check_preset_textures.mjs` re-verifies this table against the model.

export interface AvatarTextureRule {
  /** Material name as authored in the model. */
  material: string;
  /** Basenames under `textureBase` (extension included). */
  baseColor?: string;
  normal?: string;
}

export interface AvatarPreset {
  id: string;
  label: string;
  /** Short note shown under the picker. */
  hint?: string;
  url: string;
  /** Prefix for the files named in `textures`. */
  textureBase?: string;
  textures?: AvatarTextureRule[];
}

export const AVATAR_PRESETS: AvatarPreset[] = [
  {
    id: "default",
    label: "기본 아바타",
    hint: "VRM · 표정까지 트래킹",
    url: "/models/avatar.vrm",
  },
  {
    id: "spiderman",
    label: "스파이더맨",
    hint: "FBX · 표정 없음 (약 32MB 다운로드)",
    url: "/models/spiderman/spiderman.fbx",
    textureBase: "/models/spiderman/tex/",
    textures: [
      // Suit mesh: material name == tile index.
      { material: "1", baseColor: "Suit_BaseColor.1001.webp", normal: "Suit_Normal.1001.webp" },
      { material: "2", baseColor: "Suit_BaseColor.1002.webp", normal: "Suit_Normal.1002.webp" },
      { material: "3", baseColor: "Suit_BaseColor.1003.webp", normal: "Suit_Normal.1003.webp" },
      { material: "4", baseColor: "Suit_BaseColor.1004.webp", normal: "Suit_Normal.1004.webp" },
      { material: "5", baseColor: "Suit_BaseColor.1005.webp", normal: "Suit_Normal.1005.webp" },
      // Accessories.
      { material: "Lense", baseColor: "Acc_BaseColor.1011.webp", normal: "Acc_Normal.1011.webp" },
      { material: "Frame", baseColor: "Acc_BaseColor.1001.webp", normal: "Acc_Normal.1001.webp" },
      { material: "Webshotter", baseColor: "Acc_BaseColor.1002.webp", normal: "Acc_Normal.1002.webp" },
      { material: "LED", baseColor: "Acc_BaseColor.1003.webp", normal: "Acc_Normal.1003.webp" },
      { material: "Shoe", baseColor: "Acc_BaseColor.1012.webp", normal: "Acc_Normal.1012.webp" },
    ],
  },
];

export const DEFAULT_PRESET = AVATAR_PRESETS[0];
