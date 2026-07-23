// Result-explanation content shared by the module result screens and the
// integrated summary. Personal-color guidance follows standard 4-season
// personal-color theory (undertone / value / chroma); heart-metric copy
// follows HRV literature (Task Force 1996, Kubios, Baevsky). All heart
// figures are wellness estimates from a short webcam measurement, not
// medical diagnoses.

import type { SeasonTone, FaceShape } from "./types";

export interface SwatchColor {
  name: string;
  hex: string;
}

export interface SeasonGuide {
  summary: string;
  /** Best-matching colors for this tone. */
  palette: SwatchColor[];
  /** Colors that tend to wash this tone out. */
  avoid: SwatchColor[];
  makeup: string;
  hair: string;
  /** "골드" | "실버" — which jewelry metal flatters this tone. */
  metal: string;
  fashion: string;
}

export const SEASON_GUIDE: Record<SeasonTone, SeasonGuide> = {
  "spring-warm": {
    summary: "따뜻하고 밝고 맑은 톤 — 노란기가 도는 화사하고 생기 있는 인상이에요.",
    palette: [
      { name: "코랄", hex: "#FF6F61" },
      { name: "피치", hex: "#FFB07C" },
      { name: "살몬 핑크", hex: "#FF8C69" },
      { name: "아이보리", hex: "#FFF4D6" },
      { name: "애플 그린", hex: "#A8D66A" },
      { name: "골든 옐로", hex: "#FFC93C" },
    ],
    avoid: [
      { name: "블랙", hex: "#111111" },
      { name: "차가운 버건디", hex: "#5C1A2B" },
      { name: "회색빛 파스텔", hex: "#B8B8C0" },
    ],
    makeup: "코랄·피치·살구빛 립과 블러셔로 화사하게. 베이스는 노란기가 도는 밝은 톤으로 맑고 투명하게.",
    hair: "밝은 브라운·골든 브라운·라이트 카멜 등 노란기 도는 밝은 갈색.",
    metal: "골드",
    fashion: "밝고 선명한 색으로 얼굴 주변을 밝히면 생기가 살아나요. 상의에 코랄·피치를 두면 혈색이 좋아 보여요.",
  },
  "summer-cool": {
    summary: "부드럽고 차분한 톤 — 푸른기가 도는 은은한 파스텔·뮤트 인상이에요.",
    palette: [
      { name: "라벤더", hex: "#C9B6E4" },
      { name: "파우더 블루", hex: "#A9C7E8" },
      { name: "로즈 핑크", hex: "#F4A6C0" },
      { name: "소프트 민트", hex: "#B5E0D2" },
      { name: "그레이시 블루", hex: "#8FA8C8" },
      { name: "라이트 그레이", hex: "#D6D9DE" },
    ],
    avoid: [
      { name: "오렌지", hex: "#FF7A1A" },
      { name: "머스타드", hex: "#C9971B" },
      { name: "골드 브라운", hex: "#8A5A1E" },
    ],
    makeup: "로즈·핑크·라벤더 계열의 부드러운 립·블러셔. 베이스는 핑크빛이 도는 쿨 톤으로 촉촉하고 은은하게.",
    hair: "애쉬 브라운·라벤더 애쉬·소프트 로즈 브라운 등 붉은기 없는 회갈색.",
    metal: "실버",
    fashion: "파스텔·뮤트 톤으로 톤온톤 매치하면 우아해요. 대비가 강한 조합은 피하고 부드럽게 연결해요.",
  },
  "autumn-warm": {
    summary: "깊고 따뜻하고 그윽한 톤 — 노란·붉은기가 도는 성숙한 인상이에요.",
    palette: [
      { name: "카멜", hex: "#C19A6B" },
      { name: "머스타드", hex: "#D4A017" },
      { name: "올리브", hex: "#808000" },
      { name: "버건디", hex: "#7B2D26" },
      { name: "테라코타", hex: "#CB6843" },
      { name: "딥 브라운", hex: "#5C4033" },
    ],
    avoid: [
      { name: "네온 컬러", hex: "#39FF14" },
      { name: "차가운 푸시아", hex: "#FF2E8B" },
      { name: "순수 화이트", hex: "#FFFFFF" },
    ],
    makeup: "벽돌색·브릭·테라코타 립과 코랄 브라운 블러셔. 베이스는 황금빛이 도는 웜 톤으로 매트하고 차분하게.",
    hair: "다크 브라운·초콜릿·카퍼(구리빛)·와인 브라운 등 깊고 따뜻한 갈색.",
    metal: "골드",
    fashion: "카멜·카키·브라운 어스 톤 중심으로 매치하면 고급스러워요. 스웨이드·니트·가죽 같은 질감과 잘 맞아요.",
  },
  "winter-cool": {
    summary: "선명하고 대비가 강한 톤 — 푸른기가 도는 또렷하고 강렬한 인상이에요.",
    palette: [
      { name: "퓨어 화이트", hex: "#FFFFFF" },
      { name: "블랙", hex: "#111111" },
      { name: "네이비", hex: "#1A2A5E" },
      { name: "푸시아", hex: "#E91E8C" },
      { name: "로열 블루", hex: "#2340C4" },
      { name: "와인", hex: "#8B0A32" },
    ],
    avoid: [
      { name: "오렌지", hex: "#FF7A1A" },
      { name: "카멜/베이지", hex: "#C9A87C" },
      { name: "머스타드", hex: "#D4A017" },
    ],
    makeup: "선명한 레드·푸시아·플럼 립으로 또렷하게. 베이스는 붉은기가 도는 쿨 톤으로 깨끗하고 매트하게.",
    hair: "블루블랙·다크 애쉬·진한 흑갈색 등 어둡고 차가운 계열.",
    metal: "실버",
    fashion: "흑·백 대비나 채도 높은 원 포인트 컬러로 강렬하게 매치하면 얼굴이 또렷해져요. 애매한 중간 톤은 오히려 흐릿해 보여요.",
  },
};

export const UNDERTONE_INFO: Record<"warm" | "cool" | "neutral", string> = {
  warm: "피부에 노란기·황금빛이 도는 웜 언더톤이에요. 골드 액세서리와 따뜻한 색이 잘 어울려요.",
  cool: "피부에 푸른기·붉은기가 도는 쿨 언더톤이에요. 실버 액세서리와 시원한 색이 잘 어울려요.",
  neutral: "웜과 쿨의 중간인 뉴트럴 언더톤이에요. 양쪽 색을 폭넓게 소화할 수 있어요.",
};

export const FACE_SHAPE_TIP: Record<FaceShape, string> = {
  oval: "이상적인 균형형이라 대부분의 헤어·안경·네크라인이 잘 어울려요. 얼굴을 가리기보다 이목구비를 살리는 스타일을 추천해요.",
  round: "볼륨을 위로 올린 레이어드컷이나 사이드뱅으로 세로 길이를 강조하세요. 각진 안경테와 V넥이 얼굴을 갸름하게 해줘요.",
  square: "턱선의 각을 풀어줄 웨이브·컬 스타일이 좋아요. 둥근 안경테와 라운드넥으로 부드러운 곡선을 더하세요.",
  heart: "넓은 이마와 좁은 턱의 균형을 위해 턱선 길이의 단발·아래쪽 볼륨을 주세요. 보트넥·스쿱넥이 잘 어울려요.",
  oblong: "가로 볼륨을 더하는 앞머리·웨이브로 세로 길이를 줄이세요. 가로로 넓은 안경테와 터틀넥이 균형을 잡아줘요.",
  diamond: "이마·턱에 볼륨을 주고 옆머리는 붙이세요. 상단이 넓은 캣아이 안경테와 넓은 네크라인이 잘 어울려요.",
};

export interface MetricInfo {
  /** short one-liner shown under the value */
  short: string;
  /** longer explanation shown in an expandable/detail area */
  detail: string;
  /** typical/normal range hint, if any */
  range?: string;
}

export const HEART_METRIC_INFO: Record<"bpm" | "stress" | "sdnn" | "rmssd", MetricInfo> = {
  bpm: {
    short: "1분간 심장이 뛴 횟수",
    detail:
      "성인의 안정 시 정상 범위는 약 60~100 bpm이고, 규칙적으로 운동하는 사람은 더 낮을 수 있어요. 일시적으로 높은 값은 긴장·카페인·움직임의 영향일 수 있어요.",
    range: "안정 시 60~100 bpm",
  },
  stress: {
    short: "심박 변이도로 추정한 자율신경 균형",
    detail:
      "심박 자체가 아니라 심박이 뛰는 간격의 변화(HRV)로부터 계산해요. 값이 낮으면 부교감신경(휴식·회복)이 잘 작동하는 편안한 상태, 높으면 교감신경이 우세한 긴장·피로 상태일 가능성이 커요. 한 번의 값보다 여러 번의 추세로 보는 게 정확해요.",
    range: "0(이완) ~ 100(긴장)",
  },
  sdnn: {
    short: "전체 심박 변이도(HRV)의 크기",
    detail:
      "심박 간격의 표준편차로, 자율신경의 전반적인 적응력을 나타내요. 보통 값이 높을수록 좋다고 해석해요. 다만 측정 시간이 길수록 커지는 특성이 있어, 짧게 측정한 값은 절대 수치보다 본인의 평소 추세와 비교하세요.",
    range: "높을수록 적응력 ↑",
  },
  rmssd: {
    short: "단기 부교감신경(회복력) 지표",
    detail:
      "연속된 심박 간격의 차이를 바탕으로 계산하며, 이완·회복 상태를 잘 반영해요. 값이 높을수록 회복이 잘 되는 상태예요. 성인 정상 범위는 대략 19~75 ms로, 짧은 측정에서도 비교적 안정적으로 나오는 지표예요.",
    range: "성인 약 19~75 ms",
  },
};

export const HEART_DISCLAIMER =
  "본 결과는 카메라 기반 추정값으로 의료 진단이 아니며, 건강 참고용이에요.";

export const PERSONAL_COLOR_DISCLAIMER =
  "퍼스널 컬러는 조명·화장·화면에 영향을 받는 참고용 진단이에요. 자연광에서 여러 번 측정하면 더 정확해요.";
