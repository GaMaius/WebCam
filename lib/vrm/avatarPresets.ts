// Built-in avatars offered in the VrmMotion picker.
//
// Only the default VRM ships as a preset. A Spider-Man FBX lived here briefly
// (2026-08-06) and was removed the same day: it ran too heavy — a 30MB FBX whose
// 7 skinned meshes each carry their own 52-bone skeleton, shaded with 1024px
// base + normal maps, all while MediaPipe's pose_landmarker_full runs on every
// frame. Uploaded FBX/glTF avatars are still fully supported (see
// lib/vrm/humanoidRigger.ts); a lighter rig is the way to use that path.
//
// `textureBase`/`textures` remain because a preset FBX would need them: FBX
// files routinely carry no texture references of their own, making material->map
// a convention rather than data.

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
];

export const DEFAULT_PRESET = AVATAR_PRESETS[0];
