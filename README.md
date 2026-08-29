# VisionLab AI

> **https://skillprac.vercel.app**

웹캠 하나로 나를 스캔하는 **온디바이스 비전 앱 모음**입니다.
심박수·스트레스 측정부터 퍼스널 컬러 진단, 닮은 포켓몬 찾기, 실시간 3D 모션캡처까지
**모든 추론이 브라우저 안에서** 돌아갑니다 (별도의 추론 백엔드 없음).

| 앱 | 하는 일 | 핵심 기술 |
|---|---|---|
| **HeartPulse** | 전면 카메라로 15초간 얼굴 미세 혈류를 추적해 심박수(BPM) · HRV · 자율신경 스트레스 지수 측정 | rPPG POS + DeepPhys(ONNX) 이중 엔진 |
| **PersonalFrame** | 전·후면 순차 스캔으로 조명을 보정하고 퍼스널 컬러 톤 · 얼굴 골격/비율 진단 | CIELAB · Gray World · Face Mesh |
| **PokéMatch** | 얼굴을 스캔해 시각적으로 가장 닮은 포켓몬 5마리를 찾기 | MobileCLIP2 임베딩 + 편향 제거 재랭킹 |
| **VRM Capture** | 웹캠으로 얼굴·손·포즈를 실시간 추적해 3D 캐릭터(VRM·FBX)를 움직임 | MediaPipe + Kalidokit + three-vrm |

---

## 기술 스택

`Next.js 15 (App Router)` · `TypeScript` · `React 18`
`MediaPipe Tasks Vision` (Face / Pose / Hand Landmarker) · `onnxruntime-web` (WASM)
`three.js` · `@pixiv/three-vrm` · `kalidokit`
`Backblaze B2 (S3 호환)` · `Vercel` 배포

앱 추가는 `lib/apps.ts`에 항목 하나 + `app/<slug>` 라우트만 만들면 됩니다.
홈 런처가 레지스트리를 그대로 렌더링하므로 레이아웃 코드를 건드릴 필요가 없습니다.

---

## 각 앱에서 실제로 푼 문제

### HeartPulse — rPPG

`ubicomplab/rPPG-Toolbox`의 **POS 알고리즘을 TypeScript로 직접 포팅**하고,
사전학습 **DeepPhys** 모델(ONNX)을 `onnxruntime-web`으로 병행 실행하는 이중 엔진입니다.
MediaPipe FaceLandmarker로 ROI를 잡고, 자체 FFT로 BPM · HRV · 스트레스 지수를 계산합니다.

### PokéMatch — 라벨 없는 문제를 세 단계로 나누기

**정답 라벨이 존재하지 않는 문제**입니다(얼굴↔포켓몬 매칭 데이터셋은 없습니다).
그래서 지도학습 분류가 아니라 **임베딩 채점 → 얼굴 계측 → 멀티모달 LLM 심사**로 나눠 풀었습니다.

```
MediaPipe 얼굴 crop
  ├─ (a) MobileCLIP2 임베딩 → 후보 풀을 이 사람 기준으로 z-score 채점
  ├─ (b) faceFeatures.ts   → 얼굴형·비율 실측값
  └─ (c) 448² JPEG          → /api/pokematch/judge (Groq 멀티모달)
                              모델이 8개를 고르고 5개를 보여준다
```

**임베딩 단계에서 겪은 것들**

- **원시 코사인은 무의미했습니다** — 누가 스캔해도 '파라스'가 1등이 됩니다(허브니스).
  종별 평균/표준편차 기반 z-score로 **인기 편향을 제거**했습니다.
- **그래도 안 갈라졌습니다** — 기준 통계가 LFW 얼굴 분포라 실제 웹캠 셀피와 안 맞아,
  둥근 얼굴형 포켓몬이 **모두에게** 공통으로 떴습니다. 실제 테스터 임베딩을 모아
  `μ_eff = 0.3·μ_raw + 0.7·webcam_mean`으로 재보정하고 σ-floor를 적용했습니다.
- **임베딩의 약 86%는 "일반적인 사람 얼굴" 성분**이라 개인차를 덮어씁니다.
  `humanMean`을 차감해 **개인 고유 편차 벡터**를 뽑고, 이중 z-score를 혼합한 뒤
  진화계열이 상위를 독식하지 않도록 **NMS 다양성 재랭킹**을 걸었습니다.
- **모델 경량화**: MobileCLIP2-S0(가중치 동결, 512D) ONNX **fp32 44MB**를 WASM으로 실행.
  fp16 변환은 이 모델(FastViT의 Cast 노드)에서 로드 불가 모델을 만들었고,
  int8 동적 양자화는 코사인이 0.16까지 붕괴해 **fp32를 유지**했습니다.

**LLM 심사 단계에서 겪은 것들**

- **후보 목록을 프롬프트에서 뺐습니다.** 넣었더니 모델이 목록 안에서만 놀았고,
  뺀 뒤로는 1,000종 전체에서 자유롭게 답합니다. 대신 답을 좁은 풀(294종)로만 받다가
  **모델이 고른 8종 중 4종이 그 이유로 삭제**되는 일이 있었습니다(에이팜·테르나·에몽가·쌈딱 —
  하나도 마이너하지 않고, 테르나는 펜네킨·마폭시가 둘 다 풀에 있는데 중간진화만 빠진 경우).
  지금은 **갤러리 ∩ 도감 − 금지목록 = 958종**을 허용목록으로 씁니다.
- **더 많이 요청하면 더 좋아지지 않습니다.** 후보 여유를 늘리려 요청 개수를 8 → 12로 올렸다가
  **판정 자체가 무너져서** 4회 실측 후 되돌렸습니다.
- **percent는 모델이 만들지 않습니다.** 모델은 **순서만** 정하고, 표시되는 "닮은 정도 %"는
  후보 집합 기준으로 표준화한 z에서 계산합니다. 예전엔 모델에게 시켰는데 동점·오름차순을
  자주 냈고, 무엇보다 **측정값이 아니라 지어낸 숫자**였습니다.
- **라우트는 얇게, 프로토콜은 순수 함수로.** LLM 출력 파싱은 빌드로 안 잡히는 부분이라
  프롬프트 구성·파싱·레이트리밋 해석을 `judgeProtocol.ts`(순수 함수)로 분리해 `node --test`로 검증합니다.
- **429는 종류를 구분합니다.** 라우트 자체의 IP 제한(`rate_limited_local`)과 업스트림 한도
  (`rate_limited_upstream`)는 처방이 정반대인데, 맨 429만 보면 분당 버스트와 일일 소진을
  구분할 수 없어 한 라운드를 통째로 헛짚은 적이 있습니다.

> ⚠️ 이 앱의 심사 단계는 얼굴 crop 이미지를 제3자(Groq) API로 전송합니다.

### VRM Capture — 실시간 3D 모션캡처

`웹캠 → MediaPipe(Face + Pose + Hand) → Kalidokit(좌표→회전) → three-vrm → three.js` 파이프라인.

- **좌우 교차 규약** — Kalidokit Pose 솔버가 이미 좌우를 교차하므로(그래서 거울이 됨)
  포즈 본은 같은 이름끼리 꽂고, **손은 해부학 라벨로 풀어 반대쪽 VRM 손에 적용**합니다.
  이 교차를 빠뜨리면 손이 남의 팔에 얹히고, 양손을 대칭으로 들면 스왑은 안 보이는 채
  **손 각도만 심하게 틀어져 보입니다**.
- **손목 자체 솔버** — Kalidokit wrist는 손바닥 roll을 yaw에도 복사하고 바이어스까지 줘서
  손이 팔뚝에서 비틀립니다. 손바닥 기하(손가락 방향 × 손바닥 법선) 기저의 상대 회전을
  **월드 회전**으로 주입하는 솔버를 직접 만들었습니다.
- **부위별 게이팅** — "골반이 안 보이면 전체 포즈 스킵"이 원인이 되어, 가까이 앉은 사용자는
  어깨·팔꿈치가 완벽히 추적되는데도 **아바타가 T포즈로 얼어붙었습니다**.
  지금은 팔/몸통/다리를 각각의 신뢰도로 판단합니다.
- **인식 품질 = 프레임레이트 문제** — MediaPipe VIDEO 모드는 프레임 간 트래킹을 하므로 굶기면
  모든 단계가 나빠집니다. 무거운 두 단계(pose/hand)를 **번갈아 실행**하고 직전 결과를 유지합니다.
  손 인식이 좋았던 참고 앱을 뜯어보니 모델·delegate·confidence가 **전부 동일**했고,
  차이는 오직 "손 모델만 단독 실행 + 640×480" 이었습니다. 튜닝이 아니라 동시 실행 모델 수의 문제였습니다.
- **FBX / glTF 업로드 지원** — 非VRM 리그를 VRM 휴머노이드로 어댑트합니다.
  `VRMHumanoidRig`가 rest 회전을 영점으로 되곱하므로 **모델의 rest 포즈가 곧 identity**인데,
  Mixamo FBX는 A-pose라 그대로 쓰면 팔이 항상 45° 내려간 채 움직입니다.
  휴머노이드 생성 전에 실제 T-pose로 정렬하고, Z-up→Y-up · cm→m · 발 접지 · 정면 방향까지 자동 보정합니다.

---

## 테스트에서 얻은 교훈

`npm test` (Node 내장 `node --test`, `.ts` 직접 실행). 실제 `avatar.vrm`을 Node에서 로드해
기하학적으로 검증하는 테스트까지 포함합니다.

1. **거리는 방향이 아니다.** "주먹 쥐면 손끝~손목 거리가 짧아진다"로 검증했더니
   뒤로 꺾여도 똑같이 짧아져서(0.110 vs 0.103) **부호가 반대인 코드가 통과**했습니다.
2. **추론한 값을 테스트에 박으면 테스트가 버그를 보증한다.** 솔버 소스의 clamp 범위에서
   기대값을 추론해 넣었고, 통과하는 채로 실기기에서 역굽힘이 났습니다.
3. **직관으로 만든 픽스처는 코드와 싸운다.** 지금은 원하는 결과 방향에서 항등식으로 거꾸로 생성합니다.

---

## 구조

```
app/
  page.tsx              홈 런처 (lib/apps.ts 레지스트리를 렌더)
  heartpulse/           rPPG 심박수·스트레스
  personalframe/        CIELAB 퍼스널컬러·얼굴 골격
  pokematch/            닮은 포켓몬 찾기
  vrmmotion/            VRM Capture — 실시간 3D 모션캡처
  api/recordings/       B2 presigned URL 발급 (서버리스)
components/
  CameraView.tsx        모든 카메라 접근의 단일 창구 (전/후면 · 녹화 · PiP)
  vrm/                  3D 캔버스 · 컨트롤 패널
lib/
  apps.ts               앱 레지스트리
  pos.ts deepPhys.ts fft.ts        rPPG 엔진
  colorSpace.ts personalColor.ts faceShape.ts
  pokematch/matcher.ts  임베딩 추론 · z-score 재랭킹
  vrm/                  vrmScene · motionAvatar · kalidokitBridge
                        boneRig · wristSolver · faceExpressions · humanoidRigger
tests/                  단위 테스트 (실제 VRM 로드 검증 포함)
```

---

## 개발

```bash
npm install
npm run dev        # http://localhost:3000
npm run build
npm test
```

카메라는 **HTTPS 또는 localhost**에서만 동작합니다.

`.env.example`을 `.env.local`로 복사해 Backblaze B2 자격증명 5개를 채우면 녹화 업로드가 활성화됩니다.

---

## 데이터 처리 고지

측정 분석(BPM · 퍼스널컬러 · 얼굴형 · 모션)은 **브라우저 내부(on-device)** 에서 수행되며,
분석 결과가 서버로 전송되지 않습니다. 다만 **촬영 원본 영상은 분석 품질 향상을 위해
Backblaze B2 스토리지에 저장**됩니다 (브라우저 → presigned URL로 직접 업로드).
자체 추론 백엔드는 없으며, Vercel 서버리스 함수는 업로드 URL 발급만 담당합니다.

---

## 브랜치

- **`visionlab`** — 실제 제품 브랜치이자 Vercel production branch
- `master` — 예전 테스트용 더미(Express 웹캠 필터) 앱. 참고하지 말 것
