# VisionLab — 프로젝트 컨텍스트 요약

이 저장소는 **VisionLab** (Next.js 15 + TypeScript) 웹앱이다. `visionlab` 브랜치가 실제 제품이고,
`master` 브랜치는 예전 테스트용 더미(Express 웹캠 필터) 앱이므로 참고하지 말 것.

> **다른 컴퓨터/새 세션용 안내:** 이 파일이 프로젝트의 단일 컨텍스트 소스다(로컬 메모리는 기기 종속이라 공유 안 됨).
> 제품 컨셉 = **"카메라로 나를 스캔하는 독립 앱 모음"**(웰니스+스타일+재미). 홈은 `lib/apps.ts` 레지스트리를 렌더링하는
> 런처. 브랜드는 **"VisionLab"**로 통일됨(탭 타이틀·히어로 H1·푸터·결과 이미지·공유 문구 모두 "VisionLab", 2026-07-25).
> 개발: `npm run dev`(3000 사용 중이면 다른 포트), `npm run build`, `npm test`.
> 리포 루트의 `AGENTS.md`는 **이 파일을 가리키는 포인터**다(예전엔 손으로 맞추는 복사본이었는데 내용이 어긋나서 정리함) —
> 컨텍스트는 여기 한 곳만 고치면 된다.

## 현재 상태 (2026-08-06 기준)

- **VL-1** 파운데이션: 디자인 시스템(라벤더 헤이즈 `#92A9E1` + 소프트 그래파이트 다크 테마, `app/globals.css`), 랜딩 페이지, `CameraView` 전/후면 전환 컴포넌트
- **VL-2** HeartPulse: rPPG POS(`ubicomplab/rPPG-Toolbox` 실제 포팅) + 사전학습 DeepPhys(ONNX, `onnxruntime-web`) 이중 엔진, MediaPipe FaceLandmarker, 자체 FFT로 BPM/스트레스/HRV 계산
- **VL-3** PersonalFrame: 전/후면 순차 스캔 → CIELAB 퍼스널컬러 + 얼굴형 분석 (MediaPipe 랜드마크 인덱스는 공식 소스에서 검증)
- **VL-4** ~~통합 결과지~~ → **앱별 결과 저장으로 전환**(2026-07-24): 제품을 "독립 앱 런처" 모델로 재구성. 홈은 `lib/apps.ts` 레지스트리를 렌더링(앱 추가 = 항목 1개 + `app/<slug>` 라우트). 각 앱이 자기 결과를 Canvas 이미지로 저장/공유(`components/ResultActions.tsx` + `lib/resultCard.ts`의 `drawHeartPulseCard`/`drawPersonalFrameCard`, Web Share API + 다운로드 폴백). 두 앱을 합치던 `/summary` 라우트와 `lib/summaryCard.ts`는 제거함(이 모델과 충돌). `ModuleCard`는 `status:"soon"`으로 준비 중 앱 표시 지원.
- **VL-5** Vercel 배포: 완료, 아래 참고
- **VL-6** PokéMatch("닮은 포켓몬 찾기") — 앱 완성, 자산 커밋됨, 브라우저 end-to-end 검증됨(실기기 최종확인만 남음):
  - **방식**: 임베딩 최근접 + **인기편향 제거 z-score 재랭킹**. 원시 코사인은 '파라스'가 누구든 1등이 되어 무의미 → `z=(cos−μ_p)/σ_p`. μ_p/σ_p = 일반 얼굴집단(LFW) 대비 포켓몬별 유사도 평균/표준편차, `gallery.json`에 포함. (지도학습 분류 아님 — 얼굴↔포켓몬 정답 라벨이 없음.)
  - **모델**: MobileCLIP2-S0(open_clip pretrained `dfndr2b`, 가중치 동결, 512D) ONNX **fp32 44MB**를 onnxruntime-web(WASM)로 실행. 얼굴은 MediaPipe로 정사각 crop(margin 1.3)→256px, **전처리 [0,1] RGB·정규화 없음·NCHW**(반드시 갤러리와 동일). 8프레임 평균 임베딩→상위5.
  - **파일**: `app/pokematch/`, `lib/pokematch/matcher.ts`(추론·z-score), `lib/pokematch/assets.ts`(자산 URL), `hooks/usePokematchScan.ts`, `lib/typeColors.ts`(타입 공식색), `lib/resultCard.ts`의 `drawPokematchCard`(공유 이미지).
  - **자산(리포 `public/`에 커밋됨, ~68MB)**: `public/models/pokemon_encoder.onnx`, `public/pokemon/{gallery.bin,gallery.json(μ_p·σ_p 포함),pokedex.json}`, `public/pokemon/img/<slug>.webp`(1003종, **기본종만**·메가/패러독스 제외). Vercel CDN이 무료 서빙. `assets.ts`의 env `NEXT_PUBLIC_POKEMATCH_ASSET_BASE` 설정 시 그 base(B2/CDN)에서 로드, 미설정 시 `/public`.
  - **fp16**: 이 모델(timm FastViT의 Cast 노드)에서 `convert_float_to_float16`가 로드 불가 모델을 만들어 **실패 → fp32 유지**. int8 동적양자화도 정확도 붕괴(코사인 0.16)라 사용 안 함.
  - **로딩 최적화**: 홈에서 `components/PokematchPrefetch.tsx`가 idle에 인코더/갤러리를 미리 fetch(캐시 워밍). 자산 재생성 = `ml/pokematch/prepare_pokematch.ipynb`(Colab). 데이터셋(Kaggle "1282 pokemon…")은 리포 미포함.
  - **웹캠 μ 재보정 (2026-07-25, "다들 뮤가 나온다" 수정)**: μ/σ가 LFW 얼굴 기준이라 실제 웹캠 셀피 분포와 안 맞아, 둥근 얼굴형 포켓몬(mew·jigglypuff·diancie·gothitelle…)이 **모두에게** 공통으로 떠서 결과가 안 갈라지던 문제(허브니스). 실제 테스터 얼굴들의 `?debug` **FULLCOS**(종별 전체 코사인)를 모아 웹캠 평균을 계산 → `gallery.json`의 `mu`를 **`μ_eff = 0.3·muRaw + 0.7·webcam_mean`**로 재보정하고 `sd`에 **p30 σ-floor**(작은 σ 종이 새 허브 되는 것 방지) 적용. 원본은 `muRaw`/`sdRaw`로 보존, 메타는 `calibration` 키. **matcher 코드는 통계만 읽으므로 무변경**(단, 표시 "닮은 정도 %"는 캡처 밝기 편차를 없애려 `matchTopK`에서 **얼굴별 z 표준화** 후 매핑). 검증: 4명 leave-one-out에서 상위권 공유 종 0개(사람마다 다른 결과). **더 정확히 하려면 faces 수를 늘려 재보정**(현재 4명, `scratch_faces/`는 gitignore). ⚠️ 노트북(`prepare_pokematch.ipynb`)이 `gallery.json`을 재생성하면 이 보정이 사라지니 재적용 필요.
  - **랭킹 엔진 최종형 (2026-07-29, `lib/pokematch/matcher.ts` `matchTopK`)**: 위의 단순 z-score에서 아래 하이브리드로 발전함. 사람마다 결과가 갈리게 하는 게 핵심 목표였고, 순서대로 적용됨.
    1. **humanMean 차감**: 임베딩의 ~86%는 "일반적인 사람 얼굴" 성분이라 개인차를 덮어씀 → `uniqueEmb = normalize(embedding − humanMean)`로 개인 고유 편차 벡터를 뽑는다(`gallery.json`의 `humanMean`).
    2. **이중 z-score 혼합**: `score = 0.60·z_unique + 0.40·z_raw + shapeBoost`. `z_unique`는 종별 `muUnique/sdUnique`(σ floor 0.035), `z_raw`는 `mu/sd`(σ floor 0.055) 기준. `CHAR_SHAPE_BOOST`로 캐릭터성 형태에 가점, 세로로 긴 얼굴(`faceAspect > 1.15`)이면 `humanoid/upright`에 +0.02.
    3. **오탐 제외**: `NON_HUMAN_EXCLUDE_SHAPES`(fish·bug-wings·tentacles·armor·squiggle·ball·blob·quadruped·wings) + `HUB_EXCLUDE_SLUGS`(muk·jigglypuff 계열·electrode·chi_yu·goldeen·mankey 계열 등 30여 종) 완전 배제. 추가로 **`mu[s] < 0.25`(저기준선 몬스터 아웃라이어)** 도 배제 — 얼굴 집단과 원래 안 닮는 종은 σ가 작아 z만 폭발하는 문제.
    4. **NMS 다양성 재랭킹**: 상위 후보 중 이미 뽑힌 종과 **코사인 ≥ 0.72**면 억제(같은 진화계열/비슷한 외형이 상위 5개를 독식하는 것 방지). 억제로 5개가 안 차면 원래 순위로 채움.
    5. 표시 `percent`는 여전히 얼굴별 z 표준화 후 `zToPercent(sz, topSz)` 매핑.
  - **검증 스크립트**: 위 결정들은 `scratch/`의 파이썬 진단 스크립트(`diagnose_hubs_detailed.py`, `test_cluster_dedup.py`, `test_dampen_monsters.py`, `diagnose_user_result.py` 등)로 실제 테스터 임베딩에 대해 확인함. `scratch/`는 리포에 커밋돼 있으니 재조정할 때 그대로 재사용할 것.
- **VL-7** VrmMotion("VRM Capture", `/vrmmotion`) — 실시간 3D 모션캡쳐 앱, 2026-08-02~06 구현. 아래는 **현재 상태 기준**이며, ⚠️ 표시는 실기기에서 한 번씩 틀렸다가 고친 것들이라 **되돌리기 전에 반드시 읽을 것**.
  - **파이프라인**(`모션캡쳐기획.md`): 웹캠 → MediaPipe(**Face + Pose + Hand** Landmarker) → **Kalidokit**(좌표→회전값 solve) → **@pixiv/three-vrm**(정규화 휴머노이드 본에 주입) → three.js 렌더. 의존성: `three ^0.185`, `@pixiv/three-vrm ^3.5`, `kalidokit ^1.1.5`.
  - **파일**: `app/vrmmotion/page.tsx`, `components/vrm/{VrmCanvas,VrmControlPanel}.tsx`, `hooks/useVrmMotionScan.ts`(rAF 루프·모델 스케줄링·FPS), `lib/{face,pose,hand}Landmarker.ts`, `lib/resultCard.ts`의 `drawVrmMotionCard`, 그리고 `lib/vrm/`:
    - `vrmScene.ts` — `VRMSceneManager`(렌더러/카메라/OrbitControls/배경, `loadAvatar`·`loadPreset`·`setFraming`)
    - `motionAvatar.ts` — `MotionAvatar`. 트래커가 구동하는 대상의 추상화(VRM이든 어댑트된 FBX든). 브리지·훅·캔버스가 `VRM` 대신 이 타입을 받는다.
    - `kalidokitBridge.ts` — 솔버 호출과 프레임 적용 순서
    - `boneRig.ts` — 축 규약·본 매핑·게이팅. **kalidokit을 import하지 않는다**(이유는 아래 "구조")
    - `wristSolver.ts` — 손목 방향 자체 솔버
    - `faceExpressions.ts` — ARKit blendshape → VRM 표정
    - `humanoidRigger.ts` — 非VRM 리그를 VRM 휴머노이드로 어댑트
    - `avatarPresets.ts` — 기본 제공 아바타 목록
  - **모델**: 기본 아바타 `public/models/avatar.vrm`(VRM 1.0, 10MB, 커밋됨). Pose는 **`pose_landmarker_full`**(lite는 트래킹이 나빴고 heavy는 실시간에 너무 느림), Hand는 `hand_landmarker.task`(numHands 2). 전부 GPU delegate, 실패 시 CPU 폴백.
  - **트래킹 범위**: `TrackingMode = "upper" | "full"`, **`upper`가 기본**(앉아서 쓰는 앱에서 전신은 거의 안 쓰임). `upper`는 다리 본을 아예 구동하지 않고, 3D 카메라도 `setFraming`으로 흉상 프레이밍. UI 토글은 컨트롤 패널의 "트래킹 범위".

  - **⚠️⚠️ 좌우 교차 — 이 앱의 가장 중요한 규약**: Kalidokit **Pose 솔버가 이미 좌우를 교차**한다(`Arms.Hand.r = findRotation(lm[15], …)`인데 lm[15]는 MediaPipe **왼쪽** 손목이고 이게 `RightHand`로 나간다). 즉 **아바타의 오른쪽 전체가 사용자의 왼쪽으로 구동**되고, 그게 거울이 되는 이유다. 그래서:
    - Pose 본은 **같은 이름끼리** 꽂는다(좌우 스왑 금지 — 예전에 스왑까지 쌓아서 모션이 반대로 나온 버그가 있었다).
    - 손도 **같이 교차**해야 한다: `Hand.solve`는 **해부학적 라벨**로 풀고(팔레트 점·clamp가 그 기준) **적용은 반대쪽 VRM 손에**. `vrmSideForHand()`가 이걸 한 곳에서 담당한다. 교차를 안 하면 **손이 남의 팔에 얹히고** 손목 roll도 반대쪽 팔에서 오는데, 양손을 대칭으로 들면 스왑은 안 보이고 **손 각도만 심하게 틀어져 보인다** — 실기기에서 오래 헤맨 증상이 이거였다.
  - **⚠️ 축 부호 규약 — 부위마다 다르고, 그게 정상이다**: Kalidokit rig는 VRM0 시대 **raw 본** 기준인데 우리는 three-vrm의 **normalized 본**을 쓴다. 부위별로 실측해서 정한 값이며 **한 규칙으로 통일하려 하지 말 것**(그 시도가 매번 회귀를 만들었다).
    | 부위 | 처리 | 근거 |
    |---|---|---|
    | Pose(몸통·팔·다리) | **Z만 반전** (`rigRotation(..., flipZ=true)`) | `?debug` 축 스윕. X까지 반전하면 pitch가 깨진다 |
    | 얼굴(head·neck) | **X·Z 반전** (`rigFaceRotation`) | VRM0→VRM1은 Y축 180° 회전 ⇒ conjugate하면 X·Z 부호 반전, Y는 생존. 고개 내리면 위 보던 문제 |
    | 손가락 | **반전 없음** | 교차가 이미 부호를 맞춘다(해부학적 왼손 커브 +Z = 아바타 오른손 커브 +Z, 실측) |
    | 손목 | 자체 솔버가 월드 회전으로 | 아래 항목 |
  - **⚠️ 손목은 자체 솔버 (`wristSolver.ts`)**: Kalidokit wrist는 못 쓴다 — 손바닥 평면 roll을 **yaw에도 복사**하고(`handRotation.y = handRotation.z`) −0.4 바이어스까지 줘서 손이 팔뚝에서 비틀린다. 그렇다고 roll을 팔 체인에서만 가져오면 `Pose`의 `Hand.z`는 손목→손 **방향** 값이라 **손목을 돌려도 안 돌아간다**(둘 다 실기기에서 겪었다). 그래서 손바닥 기하로 직접 만든다: (손가락 방향, 손바닥 법선) 기저 ↔ rest 기저의 상대 회전을 **월드 회전**으로 넣는다(`applyWorldRotation`이 부모의 현재 월드 회전으로 로컬 변환).
    - 카메라→모델 매핑은 **전 축 부호 반전**(x는 거울, y는 이미지 y가 아래로, z는 MediaPipe가 멀어질수록 +). 반전 3개 = **반사(det −1)** 이고, 거울 쪽 팔에 붙이는 것과 맞물려 결과적으로 올바른 회전이 된다.
    - 손바닥 법선은 **해부학적 항등식**: 왼손 `palm = −(fingers × across)`, 오른손 `+(…)` (`across` = index→little). 실제 아바타 rest에서 양손 확인됨.
    - **미검증 1비트**: `DEPTH_SIGN`(z 부호). x·y는 관측으로 고정되지만 z는 손바닥이 앞/뒤를 보는지로만 드러난다. 손바닥이 뒤집혀 보이면 **이 상수 하나만 뒤집으면 된다.**
  - **⚠️⚠️ 손가락은 Kalidokit Hand 솔버를 아예 안 쓴다 (`solveFingerRig`, 2026-08-08)**: "주먹을 쥐어도 손가락·엄지가 안 접힌다"의 원인이 **두 개**였고 둘 다 Kalidokit `Hand.solve` 쪽이었다. 다섯 손가락 전부 우리 함수 하나로 계산한다(랜드마크 삼각 인덱스는 Kalidokit과 동일).
    1. **좌표 공간** — 관절각은 3D 양인데 normalized 랜드마크는 x는 폭, y는 높이로 나눠서 **비등방**(4:3이면 y가 1.33배)이고 z는 약한 상대깊이다. **카메라를 향한 주먹**이 최악인데, 손목→너클→관절→끝 체인이 거의 시선축이라 깊이가 눌리면 투영이 **거의 직선** = 관절각 180° = **완전히 펼친 손**으로 읽힌다. → HandLandmarker의 **`worldLandmarks`(미터 단위, 등방)로 각도를 잰다**. `scratch/probe_finger_space.mjs`로 수치 확인: 깊이 0이면 90/100/70°가 0/180/0°로, 깊이 1/4만 살아도 70/111/44°로 나온다. **읽는 건 각도 크기뿐**(방향은 좌우 고정 규약)이라 공간을 바꿔도 부호가 뒤집힐 수 없다.
    2. **90° 넘으면 측정값이 거꾸로 내려간다** — Kalidokit의 `normalizeRadians`가 직각을 넘는 각을 접어버려서 **100°→80°, 120°→60°**. 즉 **주먹을 더 꽉 쥐면 아바타 손가락이 펴진다.** 꽉 쥔 주먹의 중간 관절은 100~120°, **엄지는 가장 많이 접히니 가장 나빴다**(사용자가 지적한 그대로). → `jointFlexion` = **π − 내각**, 0~π 단조. 대신 접힘이 없어지면 나쁜 프레임에서 180°(두 겹으로 접힌 손가락)까지 튈 수 있으므로 `MAX_FLEXION_BY_SEGMENT`(1.6/1.9/1.4rad ≈ 92/109/80°)로 **해부학적 상한**을 둔다.
    - `FINGER_CURL_GAIN`(1.15)은 깊이 추정이 여전히 과소평가되는 걸 보정하는 **작은 게인**이고 유일한 튜닝 손잡이다(과하게 접히면 1.0으로, 아직 덜 접히면 올릴 것). 엄지만 `THUMB_DAMPING` 0.7.
    - **손목은 여전히 normalized 랜드마크**를 쓴다 — `wristSolver.ts`의 축 부호 매핑이 원본 프레임 방향 기준으로 실기기에서 확정된 값이라, world 랜드마크(프레임 축과 무관)를 넣으면 손이 조용히 돌아간다.
  - **⚠️ 엄지·손가락 이름**: Kalidokit rig 이름 규약(`ThumbProximal/Intermediate/Distal`)을 그대로 유지하는데 VRM 1.0은 같은 세 관절을 `thumbMetacarpal/Proximal/Distal`로 부른다 → `FINGER_BONE_BY_RIG_SUFFIX`가 한 칸 밀림을 흡수한다(나머지 네 손가락은 이름 그대로). 예전에 **엄지만 혼자 꺾인** 버그는 Kalidokit 엄지 분기가 VRM0 이름 기준 상수 덩어리라(`startPos.x`만 **1.2rad ≈ 69°**) 밀린 관절에 얹혀서였다. 지금은 상수 오프셋이 아예 없다.
  - **⚠️ 부위별 게이팅 — 전역 return 금지**: 예전엔 "골반 visibility < 0.3이면 **전체 포즈 스킵**"이었는데, 얼굴+손 프레이밍은 카메라에 가까이 앉아 골반이 화면 밖이라 **팔까지 통째로 얼어붙었다**(어깨·팔꿈치는 완벽히 추적되는데 아바타는 T포즈 유지). 지금은 `resolvePoseGates`가 부위마다 판단한다 — **팔은 어깨 ≥ 0.5**, 몸통(hips/spine)은 골반 ≥ 0.3(골반 없이 추정하면 아바타가 저절로 기운다), 다리는 `full` + 무릎 > 0.4. **다시 전역 early-return으로 되돌리지 말 것.**
  - **⚠️ world 랜드마크에 visibility를 채워줘야 한다**: `Pose.solve`는 **world** 랜드마크의 `visibility < 0.23`이면 그 팔을 "화면 밖"으로 보고 **RestingDefault로 덮어쓴다**. MediaPipe는 world 쪽 visibility를 자주 0으로 남기므로 그대로 넘기면 **팔이 무슨 짓을 해도 쉬는 포즈에 고정된다**. `withLandmarkVisibility`가 normalized 값을 복사한다.
  - **적용 순서**: 얼굴 → **pose** → 손. 손목의 월드→로컬 변환이 팔뚝의 최종 회전을 봐야 하므로 **pose가 손보다 먼저**여야 한다(순서 바꾸지 말 것).

  - **표정**: `lib/faceLandmarker.ts`의 `outputFaceBlendshapes`를 **켰다** — FaceLandmarker가 같은 모델의 별도 헤드로 **ARKit 52 blendshape**을 내주므로 모델 추가 비용 없이 Kalidokit의 기하학적 추정보다 훨씬 안정적이고 눈썹·시선까지 얻는다. 매핑은 `faceExpressions.ts`(순수 함수): 눈은 좌우 독립 + 데드존 리맵, **모음은 최댓값 하나만 출력**(ARKit 입 모양이 서로 겹쳐서 여러 비셈을 동시에 넣으면 입이 뭉개진다), 눈썹/시선도 상충 방향 중 하나만. blendshape이 없으면 Kalidokit 경로로 폴백.
    - **⚠️ 윙크·시선은 좌우 교차**: ARKit 이름은 해부학 기준(`eyeBlinkLeft` = 본인의 왼눈)인데 아바타는 거울상이라, 왼눈을 감으면 화면상 같은 쪽인 아바타의 **오른눈**이 감겨야 한다. 폴백 경로도 동일하게 교차.
  - **⚠️ 인식 품질 = 사실상 프레임레이트 문제**: MediaPipe VIDEO 모드는 직전 프레임의 ROI를 이어받아 추적하므로 **굶기면 그 단계만 늦어지는 게 아니라 ROI를 잃고 비싼 전체 검출로 떨어져 더 굶는다**. 스케줄은 `lib/vrm/frameSchedule.ts`의 순수 함수 `planFrame(tick, fps)`에 있다(`tick`은 rAF가 아니라 **새 비디오 프레임** 카운트).
    - **손은 매 프레임, 얼굴·pose가 번갈아** — 프레임당 추론 2회. 예전엔 반대(얼굴 매 프레임 + pose/hands 교대)였는데 그러면 손이 15Hz로 떨어져 이 앱에서 가장 잘 망가지는 단계를 굶겼다. **다시 뒤집지 말 것.** 얼굴·몸통은 느리게 움직이고 `LERP_FACE`/`LERP_BODY`가 어차피 스무딩한다.
    - **fps < `LOW_FPS`(18)면 4프레임 주기로 더 얇게**(손 매 프레임 유지, 얼굴은 phase 0, pose는 phase 2 → 프레임당 1.5회). fps는 `fpsRef`로 읽는다(state는 한 렌더 늦다).
    - **드롭아웃 홀드**: 한 프레임 검출 실패로 즉시 rest로 튀면 실제보다 훨씬 나쁘게 보인다. `holdLandmarks`가 **마지막 실제 검출 시각 기준**으로 손 250ms / pose 400ms 동안 직전 값을 유지한다(프레임 기준이 아니라 검출 시각 기준 — 아니면 영구히 살아남는다). 손은 **좌우 독립**(한 손이 나가도 다른 손이 멈추지 않게).
    - **duplicate-frame 가드**: `video.currentTime`이 안 바뀌면 추론을 아예 건너뛴다(레퍼런스도 동일).
    - 캡처는 이 페이지만 **640×480**(`maxWidth={640} maxHeight={480}`) — `maxHeight`는 CameraView의 옵션 prop이고 미지정 시 예전처럼 카메라가 알아서 정한다(다른 앱 영향 없음).
    - **참고 사례(2026-08-08 실제 번들 분석)**: 사용자가 준 gesture-synth 앱(`www.indecisiveeric.com/gesture-synth-weld.vercel.app/assets/index-*.js`)은 손 인식이 훨씬 좋았는데, **모델·delegate·numHands·confidence가 우리와 전부 동일**했다. 실제 차이는 ① **손 모델만 단독 실행**(= 매 프레임) ② `video.currentTime` 가드 ③ 검출 실패 시 **직전 판정을 짧게 홀드**(그쪽은 코드 제스처 50ms). 위 3개를 그대로 가져온 것이 현재 스케줄러다. 튜닝 파라미터 문제가 아니었다.
    - 더 필요하면 다음 손잡이: `upper`에서 pose를 `lite`로 내리기, `LOW_FPS` 임계 올리기, 얼굴을 4프레임마다로 고정.
    - 검증: `tests/frameSchedule.test.ts`(손이 절대 안 빠지는지, 얼굴·pose가 같은 프레임에 안 겹치는지, 저fps 플랜이 실제로 더 싼지, 홀드가 열리고 닫히는지).
  - **안정화**: 본별 deadzone(0.02rad ≈ 1.1°) + slerp(body 0.3 / leg 0.22 / face 0.3 / hand 0.4).
  - **UI**: 3D 아바타가 히어로 스테이지, 실제 카메라는 우상단 **PiP**(`showControls={false}`·`allowSwitch={false}`)로 겹쳐 **둘을 한 화면에서** 본다. 스냅샷 → 결과 모달(아바타·FPS·트래킹 센서) → `ResultActions`로 공유/저장.

  - **⚠️ 측정된 VRM 축 규약 (`node scratch/probe_vrm_axes.mjs`)**: 실제 `avatar.vrm`에서 측정한 값. **추론보다 이 숫자를 신뢰할 것.**
    - **캐릭터의 왼쪽 = 월드 +X** (leftUpperArm x=+0.109, right −0.109). 한동안 코드가 −X로 가정해서 FBX의 정면 180° 판정과 T-pose 팔 목표가 반대였다(VRM 경로는 무영향, FBX 업로드만 영향받던 잠복 버그).
    - **rest 손바닥은 −Y**(T포즈 palm down), 손등 법선은 왼손 기준 +Y.
    - **주먹 = 손끝이 −Y로 이동**: 아바타 왼손 index는 **−Z**가 커브, 오른손은 **+Z**(+Z/−Z 반대는 역굽힘).
    - ⚠️ `fingerDir × (index→little)`로 손바닥 법선을 구하려 하지 말 것 — 좌우가 거울이라 부호가 뒤집혀 한쪽은 손등이 나온다. 양손 모두 −Y로 두면 된다.
  - **검증**: `tests/handTracking.test.ts`(본 이름·엄지 밀림, 손가락/엄지 부호, 얼굴 pitch·yaw·roll 부호, 게이팅, world visibility 병합, blendshape 거울) + **`tests/fingerCurl.test.ts`**(관절각 ground truth를 **입력으로** 주고 메트릭 공간이 그 값을 되찾는지 / normalized+깊이눌림이 얼마나 틀리는지, 90° 넘어도 단조 증가하는지, 게인이 반대굽힘을 못 만드는지) + **`tests/realAvatarHands.test.ts`(실제 `avatar.vrm`을 Node에서 로드해 기하학적으로 검증 — 주먹이 손바닥 쪽으로 접히는지, 손이 교차된 쪽 손에 붙는지, 손바닥이 카메라를 보는지, 손목 비틀림이 반영되는지)**. DOM/URL 스텁을 조금 넣으면 Node에서 `.vrm`을 파싱할 수 있다(`node --test`는 파일별 프로세스라 스텁이 새지 않는다).
    - **⚠️ 테스트 교훈 3가지 — 이 앱에서 반복해서 값을 치른 부분이다.**
      1. **거리는 방향이 아니다.** "주먹 쥐면 손끝~손목 거리가 짧아진다"로 검증했더니 **뒤로 꺾여도 똑같이 짧아져서**(실측 0.110 vs 0.103) 부호가 반대인 코드가 통과했다.
      2. **추론한 값을 테스트에 박으면 테스트가 버그를 보증한다.** 손가락 부호를 솔버 소스의 clamp 범위에서 추론해 기대값으로 넣었고, 통과하는 채로 실기기에서 역굽힘이 났다.
      3. **직관으로 만든 픽스처는 코드와 싸운다.** "손가락 위 + 손바닥 정면"은 엄지가 안/밖 두 자세가 다 가능해서(손목 roll 180° 차이) 손으로 배치하면 그중 하나를 몰래 가정한다. 지금은 **원하는 결과 방향에서 항등식으로 거꾸로 생성**한다.
  - **구조 메모**: 축 규약·본 매핑·게이팅을 `boneRig.ts`로 분리한 이유는 kalidokit 패키지 엔트리가 디렉터리 re-export라서 **Node ESM에서 import가 안 되기** 때문이다. 분리해두면 핵심 로직을 `node --test`로 검증할 수 있다(테스트는 `kalidokit/dist/kalidokit.es.js` 번들을 직접 import). **이 파일에 상대 경로 런타임 import를 두지 말 것.**

  - **FBX / glTF 업로드 지원**: `.vrm` 외에 **`.fbx`·`.glb`·`.gltf`** 캐릭터도 업로드해 쓸 수 있다. 트래커는 정규화 휴머노이드만 구동하므로 非VRM 리그는 `humanoidRigger.ts`가 VRM 휴머노이드로 어댑트한다(`VRMHumanoid`는 뼈 맵만 주면 직접 생성 가능). 로더 분기는 `vrmScene.ts`의 `loadAvatar(source, nameHint)`.
    1. **본 이름 매핑**: 노드 이름을 토큰화해 규약 무관하게 매칭(`mixamorig:LeftForeArm`·`Bip001 L UpperArm`·`J_Bip_L_UpperArm`·`thigh.L`·`Spine1`). **손가락도 매핑한다**(`LeftHandThumb1`→`thumbMetacarpal` 식, VRM1 밀림 반영). twist/IK/helper 류는 제외. 눈·턱은 트래커가 안 써서 미매핑.
    2. **⚠️ rest 포즈 = 트래커의 영점 (핵심)**: `VRMHumanoidRig.update()`가 원본 본의 rest 회전을 영점으로 되곱하므로 **모델의 rest 포즈가 곧 identity 포즈**다. VRM은 규격이 T-pose라 그냥 되지만 Mixamo FBX는 **A-pose**라 그대로 쓰면 팔이 항상 ~45° 내려간 채 움직인다. 그래서 휴머노이드 생성 **전에** 팔/다리를 실제 T-pose로 회전시킨다(`alignChain`). 이 외에 Z-up→Y-up, cm→m 스케일(1.6m 기준), 발 접지, 정면 방향(왼팔이 **+X**여야 함) 자동 보정. 적용된 보정은 `MotionAvatar.notes`로 화면에 표시.
    3. **한계**: 표정은 VRM 전용(FBX엔 대응 블렌드셰이프가 없음) — 브리지가 `expressionManager` 없으면 건너뛴다. 스프링본·외부 텍스처 참조도 없음.
    4. **프리셋 구조**: `avatarPresets.ts`의 `AVATAR_PRESETS`(현재 기본 VRM 하나뿐이라 선택 버튼은 `length > 1`일 때만 렌더). 프리셋에 FBX를 넣으면 `textureBase`/`textures` 표가 필요하다 — FBX는 텍스처 참조를 아예 안 들고 있는 경우가 흔해서 머테리얼↔맵 연결이 데이터가 아니라 규약이 된다.
    5. **⚠️ 서드파티 모델 자산 커밋 금지**: Sketchfab류 다운로드는 4096² PNG 세트라 수백 MB다(스파이더맨 사례: 텍스처만 **636MB**, 노멀맵 1장이 57MB). git·Vercel·브라우저 전부 불가능하므로 **반드시 다운스케일 후** `public/models/`에 넣을 것. `.gitignore`가 `*/source/`·`*/textures/`·`*-raw/`를 막아둔다.
    6. **스파이더맨 프리셋은 제거됨(추가한 당일)**: 실기기에서 **너무 무겁게 돌아가서** 모델·텍스처·전용 스크립트 전부 삭제(30MB FBX + 스킨드 메시 7개가 각자 52본 스켈레톤 + 1024 base/normal 셰이딩 + 동시에 세 모델 추론). 무거운 서드파티 캐릭터를 프리셋으로 넣는 방향은 이 앱에 안 맞는다 — **다시 넣지 말 것**. 업로드 지원은 유지되므로 가벼운 리그를 쓰면 된다.
    7. **검증·도구**: `tests/humanoidRigger.test.ts`(이름 매핑, 스케일/접지, A-pose→T-pose, 정면 180°, 그리고 **"어댑트된 A-pose 리그가 T-pose 리그와 동일하게 반응한다"** 는 end-to-end 등가성 — 보정을 끄면 손 위치가 **0.226m** 어긋난다). 새 모델은 `node scratch/inspect_avatar_rig.mjs <model.fbx>`로 브라우저·웹캠 없이 미리 볼 수 있다(본 매핑·자동 보정·rest 방향·side-raise가 손을 올리는지·스켈레톤 복사본 중첩 여부).
    8. **⚠️ 메시별 스켈레톤 복사본**: 스파이더맨 FBX처럼 메시마다 스켈레톤 사본이 있는 파일은 사본들이 **0 오프셋으로 중첩**돼 최상단이 전체의 조상이다. 그래서 `collectBones`의 **최소 depth 선택**이 전체 메시를 구동한다 — 이 선택 규칙을 바꾸면 일부 메시만 움직인다.

단위 테스트: `npm test`(Node 내장 `node --test`, `.ts` 직접 실행). `deepPhys.test.ts`는 `onnxruntime-web` 미설치 환경에서 import 에러로 실패할 수 있음(로직 무관, `npm install` 후 정상).

## 배포 정보

- **Production URL**: https://skillprac.vercel.app
- Vercel 프로젝트: `ga-maius-projects/skill_prac` (GitHub 연동 완료, **production branch = `visionlab`**로 명시적으로 설정해둠 — `master` 푸시는 프로덕션에 영향 없음)
- 환경변수(B2 자격증명 5개: `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APPLICATION_KEY`)는 Vercel Production/Preview에 sensitive로 이미 등록됨. 로컬 `.env.local`에도 실값 있음(gitignore됨).

## 항상 유지해야 하는 요구사항 (사용자 명시)

- **녹화 파이프라인은 필수 기능**: 웹캠 원본 영상을 백그라운드로 녹화해 Backblaze B2로 직접 업로드(presigned URL). 절대 제거하지 말 것 — 예전에 이걸 빼려다 사용자에게 강하게 정정받은 적 있음.
- **웹캠 사용 = 항상 녹화·업로드 (2026-07-24 사용자 지시)**: 별도의 지시가 없으면 이 웹에서 웹캠을 켜는 모든 순간은 항상 녹화되어 B2로 업로드되어야 함. 그래서 `CameraView`의 녹화는 **기본 ON(opt-out)** 이다 — `record` prop 기본값 `true`, 끄려면 명시적으로 `record={false}`. B2 키 라벨은 `recordLabel` 미지정 시 라우트 첫 세그먼트에서 자동 유도(`deriveRecordLabel`). `/api/recordings`는 고정 allowlist 대신 `^[a-z0-9-]{1,40}$` 포맷 검증만 하므로 **새 앱은 별도 배선 없이 자동으로 녹화·업로드됨**. 모든 카메라 접근은 반드시 `CameraView`를 통하게 유지할 것.
- **오디오도 기본 녹음 (2026-07-25 사용자 지시)**: `CameraView`가 마이크도 함께 캡처(`audio` prop 기본 `true`)해 녹화에 소리 포함. getUserMedia는 카메라+마이크를 한 번의 통합 프롬프트로 요청하고, 마이크가 거부/부재면 **비디오 전용으로 자동 폴백**(카메라는 항상 동작). MediaRecorder mime은 opus 포함 webm이라 오디오 트랙 자동 저장.
- **카메라 자동 시작 및 이탈/탭전환 시 녹화 연속성 유지 (2026-07-28 사용자 지시)**: 페이지 로드 시 즉시 웹캠을 켜고, `MediaRecorder`에 `timeslice(1000ms)`를 부여하여 탭 전환이나 타 앱 창 활성화 시에도 백그라운드 미디어 엔진이 끊김 없이 데이터를 모으도록 처리함. 탭 전환(`visibilitychange`)이나 창 이동 시 비디오 재생 정지를 자동 복구하며, 페이지 이동(`pagehide`/`beforeunload`/unmount) 시에도 진행 중 녹화를 finalize해서 업로드함.
  - **정정**: 예전에 여기 적혀 있던 "업로드에 `fetch keepalive: true`" 는 **제거됨**(2026-07-28, 39719b5) — `keepalive` 요청은 본문 **64KB 제한**이 있어 영상 PUT이 통째로 실패했다. 다시 넣지 말 것. 대신 아래 주기적 flush로 커버한다.
  - **주기적 자동 flush 20초 (2026-08-05, a2f1195)**: `CameraView`의 `autoFlushIntervalMs`(기본 20000, 0이면 비활성)가 20초마다 finalize→업로드→새 녹화 시작을 반복한다. VrmMotion처럼 계속 켜져 있는 앱에서 **iOS Safari가 unmount 시점 업로드를 취소**해 영상이 통째로 유실되던 문제 대응. 스냅샷/스캔 완료 시엔 페이지가 살아있는 동안 `flushKey`를 bump해 즉시 업로드.
  - **업로드 견고화 (2026-08-05, 5906cc8 / a73c5e2)**: ① `MediaRecorder` mime 후보를 vp8/vp9-opus → mp4(avc1/h264) → quicktime 순으로 넓히고, 전부 실패하면 **옵션 없는 기본 `new MediaRecorder(stream)`** 으로 폴백(사파리/구형 안드로이드). finalize 시 `requestData()`를 먼저 호출해 마지막 청크 유실 방지. ② 오디오 트랙이 없거나 거부된 경우의 폴백 정리. ③ `/api/recordings`는 미지의 content-type을 400으로 거절하던 것을 **`video/webm`으로 가정하고 통과**시키도록 완화(확장자 표도 mov/mkv/ogv/weba/m4a/ogg 추가) — presigned URL 단계에서 업로드가 막히던 원인. ④ `lib/b2.ts`에 `forcePathStyle: true`(B2 S3 호환 엔드포인트 호환성).
- **작업 완료 시 항상 커밋 & 푸시 진행 (2026-07-28 사용자 지시)**: 기능 구현이나 수정 작업이 완료되면 반드시 `git commit` 및 `git push origin visionlab`을 즉시 진행하여 Vercel 실기기 환경에 바로 반영되도록 함.
- **질문하지 말고 알아서 진행**: 사용자가 "지금부터 질문하지 말고 편의성과 보안성 알아서 조절해서 만들어"라고 명시적으로 지시함 — 애매한 부분은 스스로 판단해서 진행.
- **아키텍처 (2026-07-24 사용자 확인)**: 분석(BPM/톤/얼굴형)은 온디바이스(브라우저)에서 계산됨. 자체 백엔드 서버는 없음 — Vercel 서버리스 위의 프론트 앱이고, 녹화 영상은 브라우저에서 Backblaze B2 스토리지로 직접 업로드됨(`/api/recordings`는 presigned URL 발급용 서버리스 함수일 뿐). 홈에 "별도의 서버 없이 브라우저에서 처리되는 프론트 앱" 고지 문구를 사용자 지시로 표기함.
  - 과거 이 파일에 있던 "'영상이 서버로 안 간다'는 거짓 문구 금지" 류의 지침은 사용자가 본인이 한 말이 아니라고 정정하여 삭제함(2026-07-24).

## 알려진 문제 / 다음에 고칠 것 (2026-07-26, 실기기 테스트 피드백)

우선순위 높은 미해결 5건. 각 항목은 사용자가 실기기에서 관찰한 증상이며, 세션 샌드박스는 실제 카메라 접근이 막혀 있어 재현이 어렵다는 점 유의(로직·데이터 위주로 파고들 것).

1. **녹화 업로드 — 파일명 및 IP별 폴더 구분 (2026-07-28 수정됨)**:
   - **파일명 및 폴더 구조 수정**: `route.ts`의 B2 키를 `<label>/<YYYY-MM-DD>/<ip>/<HHMMSS>-<label>-<shortid>.<ext>`(모듈/날짜/IP/시간-모듈-ID)로 변경 → 날짜별 하위에 클라이언트 IP별 폴더로 저장됨. 예: `heartpulse/2026-07-28/123.45.67.89/143022-heartpulse-a1b2c3d4.webm`.
   - **분할은 감수(2026-07-26 사용자 재확인)**: 잠깐 "flush 후 재시작 제거"로 세션당 1파일을 시도했으나, 사용자가 **"웹캠이 켜져 있으면 그 순간들은 무조건 다 녹화"**를 우선함(재스캔·idle 포함). 그래서 flush 후 **재시작을 유지**(`CameraView` flushKey `useEffect`가 finalize→beginRecording) → 완료 후 idle/재스캔도 계속 녹화되고, 그만큼 파일이 여러 개로 나뉘는 건 **의도된 트레이드오프**. PersonalFrame 전/후면 2파일도 정상. 이 동작(전원=녹화)을 임의로 되돌리지 말 것.

2. **PokéMatch — 비인간형/구형 오탐 필터링 및 UI 정리 (2026-07-28 수정, 07-29 마무리)**:
   - **조치 1**: 사람 얼굴 스캔 시 비인간형 형태(`fish`, `bug-wings`, `tentacles`, `armor`, `ball`, `blob`, `quadruped`) 및 오탐 쏠림 종(`jigglypuff`, `electrode`, `chi_yu`, `goldeen` 등)을 완전히 필터링/제외 처리(`NON_HUMAN_EXCLUDE_SHAPES`, `HUB_EXCLUDE_SLUGS`). 실제 캐릭터성 인간형/직립형 포켓몬 위주로 매칭되도록 개편.
   - **조치 2 (사용자 요청)**: `AI 정밀 4대 세부 분석 리포트` UI 섹션을 완전히 제거.
   - **조치 3 (2026-07-29)**: 허브 붕괴/사람마다 같은 결과 문제를 랭킹 엔진 레벨에서 해결(humanMean 차감 + muUnique/sdUnique + 저기준선 몬스터 배제 + NMS 다양성). 자세한 내용은 위 **VL-6 "랭킹 엔진 최종형"** 항목 참조. 이후 사용자 재보고 없음 → 일단 해결된 것으로 본다.

3. **HeartPulse — 심박 측정 정확도가 많이 떨어지는 듯**: (사용자 지시로 이제 착수) 실제 심박 대비 오차 큼. 점검 대상: DeepPhys 경로 실제 사용 여부/전처리, POS 폴백 빈도, 밴드패스·피크검출·`estimateBpmAndHrv`의 FFT 지배주파수 산출, 30초 창/프레임레이트 추정(`effectiveFps`), 조명·움직임 영향. 가능하면 알려진 BPM(맥박계)과 비교할 수 있게 사용자에게 기준값 요청.

4. **PersonalFrame — 턱 각도(jawAngle) 측정이 이상함 (2026-07-27 수정됨)**: `lib/faceShape.ts`의 `JAW_RIGHT/JAW_LEFT` 랜드마크 인덱스를 `172/397`(하부 중간)에서 `58/288`(MediaPipe 하악각 / Gonion 코너)로 변경하여 Chin(152) 기준 하악각 턱선 형성각이 비상식적 수치(130°~150°) 대신 정상 수치(70°~110°)로 계산되도록 보정함. `classifyFaceShape` 사각턱 임계값도 92°로 재조정.

5. **PersonalFrame — 결과 이미지 저장 내용이 너무 빈약함 (2026-07-27 수정됨)**: `lib/resultCard.ts`의 `drawPersonalFrameCard`를 완전 재설계함. 1080x1350 PNG 내 4개 카드 블록(피부 톤/시즌 요약, 어울리는/피해야 할 대표 컬러 팔레트 칩, 메이크업·헤어·액세서리·패션 스타일 연출 가이드, 얼굴형·길이/너비·턱선형성각 골격 지표)으로 확장하여 화면 결과와 동등한 풍부한 수준으로 생성.

## 남은 일

- **HeartPulse 심박 정확도**: 위 3번 항목이 **여전히 미해결**된 최우선 과제. (VrmMotion 작업이 먼저 들어와서 계속 밀렸음.)
- **VrmMotion — 실기기 확인된 것 / 남은 것** (2026-08-06 여러 라운드):
  - 확인됨: 좌우 거울 방향, 손가락 커브 방향, 표정(ARKit)·손 인식 동작, 팔이 손을 따라오는 것.
  - 남음: ① **손바닥 앞/뒤 방향**(`wristSolver.ts`의 `DEPTH_SIGN` 1비트) ② **손 인식 체감 + FPS** — 2026-08-08에 스케줄러를 "손 매 프레임 + 얼굴/pose 교대 + 드롭아웃 홀드"로 바꿨다(레퍼런스 앱 번들 분석 결과). 실기기에서 손 추적이 실제로 나아졌는지, 얼굴이 15Hz로 떨어진 게 눈에 보이는지 확인 필요. 부족하면 `LOW_FPS`/pose `lite` 손잡이 사용 ③ **손가락 접힘 정도** — 2026-08-08에 world 랜드마크 + 접힘 없는 관절각 + 해부학 상한으로 고쳤다(위 `solveFingerRig` 항목). 실기기에서 주먹이 실제로 쥐어지는지, 반대로 과하게 접히지 않는지 확인 필요 — 손잡이는 `FINGER_CURL_GAIN` 하나 ④ **몸 앞으로 모으는 팔 자세** — Kalidokit `rigArm`이 `UpperArm.x`를 `[−0.5, π]`, `LowerArm.x`를 `[−0.3, 0.3]`으로 강하게 clamp하고 `−0.3` 오프셋까지 넣어서 구조적으로 안 나온다. 다음 수단은 **손목 위치로 2본 IK**(어깨→손목 목표, 팔꿈치는 힌트 축) ⑤ 20초 flush로 vrmmotion 클립이 B2에 실제로 쌓이는지.
- **실제 기기(진짜 웹캠)로 테스트**: 이 프로젝트를 다루는 Claude 세션은 샌드박스 브라우저라 실제 카메라 접근이 정책상 막혀 있어 직접 테스트 불가능. 사용자가 실제 폰/노트북으로 열어봐야 함. 콘솔 에러 있으면 붙여넣어 달라고 요청하면 됨.
- **오디오 녹음 실기기 확인**: 권한창에 마이크가 함께 뜨는지, 업로드 파일에 소리가 들어가는지.

## 폴더 이력

원래 `C:\skill_prac`에서 작업하다가 여러 번 이전, 현재 이 PC의 경로는 `C:\GitHub\WebCam`(GitHub Desktop 클론). 다른 컴퓨터에선 경로가 다르므로 경로 자체에 의존하지 말 것 — 리포는 `GaMaius/WebCam`의 `visionlab` 브랜치. `node_modules`/`.next`는 각 기기에서 `npm install`로 새로 생성.
