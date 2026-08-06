// Central registry of the standalone apps shown on the home launcher.
//
// Each app is fully independent: the user opens one, completes its flow, sees
// that app's own result, and can save it as an image. Adding a new app to the
// whole product is meant to be a one-liner here (plus its own `app/<slug>`
// route) — the home page renders straight from this list, so it scales without
// touching layout code.

export type AppIconKey = "pulse" | "palette" | "pokeball" | "vrm";

export interface AppMeta {
  /** Route slug under "/" (e.g. "heartpulse" -> /heartpulse). */
  slug: string;
  title: string;
  /** Short category tag shown above the title. */
  subtitle: string;
  desc: string;
  /** Per-app accent color (hex) used for the card and result card. */
  accent: string;
  icon: AppIconKey;
  /** "live" apps are clickable; "soon" renders a disabled "준비 중" card so
   * upcoming apps can be announced before their route exists. Defaults to live. */
  status?: "live" | "soon";
}

export const APPS: AppMeta[] = [
  {
    slug: "heartpulse",
    title: "HeartPulse",
    subtitle: "rPPG · 생체 신호",
    desc: "전면 카메라로 15초간 얼굴 미세 혈류를 추적해 심박수(BPM)와 자율신경 스트레스 지수를 측정합니다.",
    accent: "#c4553a",
    icon: "pulse",
  },
  {
    slug: "personalframe",
    title: "PersonalFrame",
    subtitle: "CIELAB · 스타일",
    desc: "전·후면 순차 스캔으로 조명을 보정하고, 퍼스널 컬러 톤과 얼굴 골격·비율을 진단합니다.",
    accent: "#4b6b3a",
    icon: "palette",
  },
  {
    slug: "pokematch",
    title: "PokéMatch",
    subtitle: "AI · 닮은꼴",
    desc: "얼굴을 스캔해 시각적 특징이 가장 닮은 포켓몬 5마리를 찾아주는 재미용 앱입니다.",
    accent: "#d64541",
    icon: "pokeball",
  },
  {
    slug: "vrmmotion",
    title: "VRM Capture",
    subtitle: "3D · 모션캡쳐",
    desc: "웹캠으로 내 얼굴과 포즈를 실시간 추적해 3D 캐릭터(VRM·FBX)를 움직이고 연출합니다.",
    accent: "#7b52b9",
    icon: "vrm",
  },
];

