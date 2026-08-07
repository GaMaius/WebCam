# VisionLab — 프로젝트 컨텍스트 요약

이 저장소는 **VisionLab** (Next.js 15 + TypeScript) 웹앱이다. `visionlab` 브랜치가 실제 제품이고,
`master` 브랜치는 예전 테스트용 더미(Express 웹캠 필터) 앱이므로 참고하지 말 것.

> **다른 컴퓨터/새 세션용 안내:** 이 파일이 프로젝트의 단일 컨텍스트 소스다(로컬 메모리는 기기 종속이라 공유 안 됨).
> 제품 컨셉 = **"카메라로 나를 스캔하는 독립 앱 모음"**(웰니스+스타일+재미). 홈은 `lib/apps.ts` 레지스트리를 렌더링하는
> 런처. 브랜드는 **"VisionLab"**로 통일됨(탭 타이틀·히어로 H1·푸터·결과 이미지·공유 문구 모두 "VisionLab", 2026-07-25).
> 개발: `npm run dev`(3000 사용 중이면 다른 포트), `npm run build`, `npm test`.
> 리포 루트의 `AGENTS.md`는 이 파일의 Codex용 미러(구버전)다 — CLAUDE.md가 최신 기준이며, 크게 바뀌면 같이 갱신할 것.

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
- **VL-7** VrmMotion("VRM Capture", `/vrmmotion`) — 실시간 3D 모션캡쳐 앱, 2026-08-02~06 구현:
  - **파이프라인**(`모션캡쳐기획.md`): 웹캠 → MediaPipe(FaceLandmarker + PoseLandmarker) → **Kalidokit**(좌표→회전값 solve) → **@pixiv/three-vrm**(정규화 휴머노이드 본에 주입) → three.js 렌더. 의존성: `three ^0.185`, `@pixiv/three-vrm ^3.5`, `kalidokit ^1.1.5`.
  - **파일**: `app/vrmmotion/page.tsx`, `components/vrm/VrmCanvas.tsx`(three 캔버스 + `loadVRM`/`takeSnapshot` ref), `components/vrm/VrmControlPanel.tsx`(배경 스타일·VRM 업로드·스냅샷·FPS), `lib/vrm/vrmScene.ts`(`VRMSceneManager`: 렌더러/카메라/OrbitControls/배경 dark·chromakey·transparent), `lib/vrm/kalidokitBridge.ts`(매핑), `hooks/useVrmMotionScan.ts`(rAF 트래킹 루프·FPS·트래킹 상태), `lib/poseLandmarker.ts`, `lib/resultCard.ts`의 `drawVrmMotionCard`.
  - **모델**: 기본 아바타 `public/models/avatar.vrm`(VRM 1.0, 10MB, 커밋됨). 사용자가 자기 `.vrm`을 업로드하면 `loader.parse(ArrayBuffer)`로 교체 가능(기본으로 되돌리기 버튼 있음). Pose 모델은 **`pose_landmarker_full`**(lite는 트래킹이 나빴고 heavy는 실시간에 너무 느림), GPU delegate 실패 시 CPU 폴백.
  - **FBX / glTF 업로드 지원 (2026-08-06)**: `.vrm` 외에 **`.fbx`·`.glb`·`.gltf`** 캐릭터도 업로드해 쓸 수 있다. 트래커는 three-vrm의 **정규화 휴머노이드**만 구동하므로, 非VRM 리그는 `lib/vrm/humanoidRigger.ts`가 VRM 휴머노이드로 **어댑트**한다(`VRMHumanoid`는 뼈 맵만 주면 직접 생성 가능하다는 점을 이용). 추상화는 `lib/vrm/motionAvatar.ts`의 `MotionAvatar`(브리지·훅·캔버스가 이제 `VRM` 대신 이 타입을 받는다), 로더 분기는 `vrmScene.ts`의 `loadAvatar(source, nameHint)`.
    1. **본 이름 매핑**: 노드 이름을 토큰화해 규약 무관하게 매칭(`mixamorig:LeftForeArm`·`Bip001 L UpperArm`·`J_Bip_L_UpperArm`·`thigh.L`·`Spine1` 전부 처리). 손가락/눈/턱은 트래커가 안 쓰므로 의도적으로 매핑하지 않고, twist/IK/helper 류는 제외.
    2. **⚠️ rest 포즈 = 트래커의 영점 (핵심)**: `VRMHumanoidRig.update()`가 원본 본의 rest 회전을 영점으로 되곱하기 때문에 **모델의 rest 포즈가 곧 identity 포즈**다. VRM은 규격이 T-pose라 그냥 동작하지만 Mixamo FBX는 **A-pose**라서 그대로 쓰면 팔이 항상 ~45° 내려간 채 움직인다. 그래서 휴머노이드 생성 **전에** 팔/다리를 실제 T-pose로 회전시킨다(`alignChain`이 world 축 델타를 로컬로 변환). 이 외에 Z-up→Y-up, cm→m 스케일(1.6m 기준), 발 접지, 정면 방향(VRM 1.0은 +Z 정면 ⇒ 캐릭터 왼팔이 −X) 자동 보정. 적용된 보정은 `MotionAvatar.notes`로 화면에 표시.
    3. **한계**: 표정(blink·모음)은 VRM 전용(FBX엔 대응 블렌드셰이프가 없음) — 브리지가 `expressionManager` 없으면 건너뛴다. 스프링본/외부 텍스처 참조도 없음.
    4. **프리셋 구조**: `lib/vrm/avatarPresets.ts`의 `AVATAR_PRESETS`가 기본 제공 아바타 목록(현재 기본 VRM 하나뿐이라 UI 선택 버튼은 `length > 1`일 때만 렌더). 프리셋에 FBX를 넣으면 `textureBase`/`textures` 표가 필요하다 — FBX는 텍스처 참조를 아예 안 들고 있는 경우가 흔해서 머테리얼↔맵 연결이 데이터가 아니라 규약이 된다.
    5. **⚠️ 서드파티 모델 자산 커밋 금지**: Sketchfab류 다운로드는 4096×4096 PNG 세트라 통째로 수백 MB다(스파이더맨 사례: 텍스처만 **636MB**, 노멀맵 1장이 57MB). git·Vercel·브라우저 전부 불가능하므로 **반드시 다운스케일 후** `public/models/`에 넣을 것. `.gitignore`가 `*/source/`·`*/textures/`·`*-raw/`를 막아둔다.
    6. **스파이더맨 프리셋은 제거됨 (2026-08-06, 추가한 당일)**: 사용자 실기기에서 **너무 무겁게 돌아가서** 모델·텍스처·전용 스크립트 전부 삭제(30MB FBX + 스킨드 메시 7개가 각자 52본 스켈레톤 + 1024 base/normal 셰이딩 + 동시에 pose_landmarker_full 추론). 무거운 서드파티 캐릭터를 프리셋으로 넣는 방향은 이 앱에 안 맞는다는 결론 — **다시 넣지 말 것**. FBX/glTF **업로드** 지원은 그대로 유지되므로 가벼운 리그를 쓰면 된다.
    7. **검증**: `tests/humanoidRigger.test.ts` — 이름 매핑, 스케일/접지, A-pose→T-pose 보정, 정면 180° 보정, 그리고 **"어댑트된 A-pose 리그가 T-pose 리그와 동일하게 반응한다"** 는 end-to-end 등가성(정규화 본에 같은 회전을 넣고 raw 손 위치 델타 비교). 보정을 끄면 같은 입력에서 손 위치가 **0.226m** 어긋나므로(임계 0.05m) 이 테스트는 실제로 회귀를 잡는다.
    8. **새 FBX 검증 도구**: `node scratch/inspect_avatar_rig.mjs <model.fbx>` — 브라우저·웹캠 없이 "이 모델이 동작할까?"에 답한다(본 매핑, 적용된 자동 보정, T-pose rest 방향, side-raise가 손을 올리는지, 스켈레톤 복사본이 중첩인지). 실제 스파이더맨 FBX에서 필수 본 15개 전부 매핑·967→1.6m·정면 180°·팔 52° 보정 후 rest dir `(∓1,0,0)`·dy +0.25로 통과한 바 있음(성능 때문에 제거된 것이고 리깅은 정상이었다). ⚠️ 그 모델처럼 **메시별 스켈레톤 복사본**이 있는 FBX는 복사본이 0 오프셋으로 중첩돼 최상단이 전체의 조상이라 `collectBones`의 **최소 depth 선택**이 전체 메시를 구동한다 — 이 선택 규칙을 바꾸면 일부 메시만 움직인다.
  - **⚠️ 축 매핑 — 절대 임의로 되돌리지 말 것**: Kalidokit rig는 VRM0 시대 **raw 본** 축 규약으로 만들어졌는데 우리는 three-vrm의 **normalized 본**을 쓴다. `?debug`(`window.__vrmDebug`)로 두 개의 DOF 분리 포즈(측면 들기=roll, 전방 들기=pitch)를 축 스윕한 결과, **오직 로컬 Z(roll)만 반전**돼 있었다(그래서 팔을 옆으로 들면 아바타 팔이 내려감). 그래서 `rigRotation(..., flipZ)`로 **포즈 유래 본에만 Z만 부호 반전**한다 — X(pitch)/Y(yaw)까지 반전시키면 pitch가 다시 깨지고, 좌우 **본 스왑은 하지 않는다**(Kalidokit이 이미 MediaPipe 좌우를 교차시켜 거울상 결과를 낸다. 예전에 스왑+전축반전을 동시에 쌓아 모션이 반대로 나왔던 버그가 이것). Face(`Face.solve`)의 head/neck 회전은 다른 규약이라 그대로 둔다.
  - **얼굴+손 모드 (2026-08-06, 기본값)**: 앉아서 쓰는 앱에서 전신은 거의 안 쓰이므로 `TrackingMode = "upper" | "full"` 을 두고 **`upper`가 기본**(`app/vrmmotion/page.tsx`의 "트래킹 범위" 토글, 3D 카메라도 `setFraming`으로 흉상 프레이밍). `upper`는 다리 본을 아예 구동하지 않는다(무릎 visibility 게이팅보다 강한 보장).
    - **표정**: `lib/faceLandmarker.ts`의 `outputFaceBlendshapes`를 **true로 켰다** — FaceLandmarker가 같은 모델의 별도 헤드로 **ARKit 52 blendshape**을 내주므로 모델 추가 비용 없이 Kalidokit의 기하학적 추정보다 훨씬 안정적이고, 눈썹·시선까지 얻는다. 매핑은 `lib/vrm/faceExpressions.ts`(순수 함수 → 테스트됨): 눈은 좌우 독립 + 데드존 리맵, **모음은 최댓값 하나만 출력**(ARKit은 입 모양이 서로 겹쳐서 여러 VRM 비셈을 동시에 넣으면 입이 뭉개진다), 눈썹/시선은 상충 방향 중 하나만. blendshape이 없으면 기존 Kalidokit 경로로 폴백.
    - **손**: `lib/handLandmarker.ts`(`hand_landmarker.task`, numHands 2, GPU→CPU 폴백) + `Kalidokit.Hand.solve` → `lib/vrm/boneRig.ts`의 `applyHandRig`.
    - **⚠️ 인식 품질 = 사실상 프레임레이트 문제 (2026-08-06)**: MediaPipe VIDEO 모드는 프레임 간 트래킹을 하므로 **굶기면 모든 단계가 나빠진다**. 그래서 무거운 두 단계를 **번갈아 실행**한다 — 매 프레임 얼굴 + (pose 또는 hands) 중 하나, 나머지는 직전 결과 유지(`HAND_EVERY_N_FRAMES`/`POSE_EVERY_N_FRAMES`=2, `POSE_PHASE`로 위상 분리). 유지가 필요한 이유: 안 하면 한 프레임씩 rest 포즈로 튄다. 캡처 해상도도 이 페이지만 **640**으로 낮췄다(`maxWidth={640}`, 추론 비용은 프레임 크기에 비례).
      - **참고 사례**: 사용자가 찾아준 gesture-synth 앱(`Desktop/www.indecisiveeric.com`)은 손 인식이 훨씬 좋았는데, 설정을 까보니 **모델·delegate·numHands가 우리와 동일**했다(`hand_landmarker.task` float16, GPU, VIDEO, numHands 2, confidence 전부 기본값). 차이는 **손 모델만 단독 실행 + 640×480**. 즉 튜닝 파라미터의 문제가 아니라 동시 실행 모델 수의 문제였다.
    - **⚠️⚠️ 손은 좌우를 교차해서 붙여야 한다 (2026-08-06 4차, 이게 근본 원인이었다)**: Kalidokit **Pose 솔버가 이미 좌우를 교차**한다 — `Arms.Hand.r = findRotation(lm[15], …)`인데 lm[15]는 MediaPipe **왼쪽** 손목이고 이게 `RightHand`로 나간다. 즉 **아바타의 오른쪽 전체가 사용자의 왼쪽으로 구동**되고, 그게 거울이 되는 이유다. 그런데 손 경로는 handedness 라벨을 그대로 VRM 좌우에 썼으니 **손이 남의 팔에 얹혀 있었고 손목 roll도 반대쪽 팔에서 가져왔다.** 양손을 대칭으로 들면 스왑은 안 보이고 **손 각도만 심하게 틀어져 보인다** — 실기기 증상이 정확히 이거였다.
      - 규칙: **`Hand.solve`는 해부학적 라벨로**(팔레트 점·clamp가 그 기준), **적용은 반대쪽 VRM 손에**. `vrmSideForHand()` / `poseHandKeyForHand()`가 이 교차를 한 곳에서 담당한다.
      - 부수 효과: 교차하면 **손가락 flipZ가 필요 없어진다**. Kalidokit 왼손 커브는 +Z이고 아바타 오른손 커브도 +Z(실측)라 그대로 맞는다. (교차 안 하던 시절엔 flipZ=true가 필요했다 — 부호가 맞는다고 매핑이 맞는 건 아니라는 예.)
    - **⚠️ 손목은 자체 솔버로 푼다 (`lib/vrm/wristSolver.ts`)**: Kalidokit의 wrist는 못 쓴다 — `handRotation.y = handRotation.z`로 roll을 yaw에 복사하고 −0.4 바이어스까지 줘서 손이 팔뚝에서 비틀린다. 그렇다고 roll을 팔 체인에서만 가져오면(중간에 그렇게 했었다) `Pose`의 `Hand.z`는 손목→손 **방향**에서 나온 값이라 **손목을 돌려도 아바타 손이 안 돌아간다**. 그래서 손바닥 기하로 직접 방향을 만든다: 랜드마크에서 (손가락 방향, 손바닥 법선) 기저를 세우고 rest 기저와의 상대 회전을 구해 **월드 회전으로 넣는다**(`applyWorldRotation`이 부모의 현재 월드 회전으로 로컬 변환 — 그래서 **pose를 먼저 풀어야** 팔뚝 회전이 반영된다).
      - 카메라→모델 매핑은 **전 축 부호 반전**(x는 거울, y는 이미지 y가 아래로, z는 MediaPipe가 카메라에서 멀어질수록 +). 반전이 3개면 **반사(det −1)** 이고, 거울 쪽 팔에 붙이는 것과 맞물려 결과적으로 올바른 회전이 된다.
      - 손바닥 법선은 **해부학적 항등식**으로 구한다: 왼손 `palm = −(fingers × across)`, 오른손 `palm = +(...)` (`across` = index→little). 이건 실제 아바타 rest에서 양손 다 확인됨. ⚠️ "손가락 위 + 손바닥 정면"은 엄지가 안/밖 두 자세가 다 가능해서(손목 roll 180° 차이) **랜드마크를 직관으로 배치하면 안 된다** — 테스트 픽스처는 원하는 결과 방향에서 항등식으로 **거꾸로 생성**한다.
      - **미검증 1비트**: `DEPTH_SIGN`(z 부호). x·y는 관측으로 고정되지만 z는 손바닥이 앞/뒤를 보는지로만 드러난다. 실기기에서 손바닥이 뒤집혀 보이면 **이 상수 하나만 뒤집으면 된다.**
    - **⚠️ 손목은 두 소스를 합친다**: `Hand.solve`는 손바닥 평면에서 roll을 뽑은 뒤 **yaw에도 같은 값을 복사**한다(`handRotation.y = handRotation.z`). 그래서 손목 회전을 통째로 넣으면 손이 이상한 각도로 꺾인다. 지금은 **flex/deviation(x·y)은 손 솔버, roll(z)은 팔 체인(`Pose.solve`의 `{side}Hand.z`, `rigArm`이 스케일·좌우보정 완료)** 에서 가져온다. 그래서 **pose를 hands보다 먼저 푼다**(순서 바꾸지 말 것).
    - **⚠️ world 랜드마크에 visibility를 채워줘야 한다**: `Pose.solve`는 **world** 랜드마크의 `visibility < 0.23`이면 그 팔을 "화면 밖"으로 보고 **RestingDefault로 덮어쓴다**. MediaPipe는 world 쪽 visibility를 안 채워주는 경우가 많아(0), 그대로 넘기면 **팔이 무슨 짓을 해도 쉬는 포즈에 고정된다**(실기기에서 이 증상이 났다). `withLandmarkVisibility`가 normalized의 값을 world로 복사한다.
    - **⚠️ 엄지 본 이름이 한 칸 밀려 있다**: Kalidokit은 VRM0 이름(`ThumbProximal/Intermediate/Distal`)을 내는데 VRM 1.0은 같은 세 관절을 `thumbMetacarpal/Proximal/Distal`로 부른다. 이름만 맞춰 꽂으면 엄지 회전이 전부 한 관절씩 밖으로 밀린다 → `FINGER_BONE_BY_RIG_SUFFIX`가 이걸 흡수한다. 나머지 네 손가락은 이름 그대로.
    - **구조**: 축 규약(`rigRotation`·flipZ)과 손가락 매핑을 `lib/vrm/boneRig.ts`로 분리했다 — kalidokit 패키지 엔트리가 디렉터리 re-export라서 Node ESM에서 import가 안 되는데, 이걸 분리해두면 **핵심 로직을 `node --test`로 검증**할 수 있다(테스트는 `kalidokit/dist/kalidokit.es.js` 번들을 직접 import). 이 파일은 상대 경로 런타임 import를 두지 말 것.
    - **⚠️ 측정된 VRM 축 규약 (`node scratch/probe_vrm_axes.mjs`)**: 실제 `avatar.vrm`(VRM 1.0)에서 측정한 값이며 **추론보다 이 숫자를 신뢰할 것**.
      - **캐릭터의 왼쪽 = 월드 +X** (leftUpperArm x=+0.109, rightUpperArm x=−0.109). ⚠️ `humanoidRigger`가 한동안 −X로 가정하고 있어서 FBX **정면 180° 판정과 T-pose 팔 목표가 반대**였다(2026-08-06 수정). VRM 경로는 영향 없었고 FBX 업로드만 영향받던 잠복 버그.
      - **rest 포즈에서 손바닥은 −Y**(T포즈 palm down). 손등 법선이 왼손 기준 +Y로 측정됨.
      - **주먹 = 손끝이 −Y로 이동**: 왼손 index는 **−Z**가 커브(+Z는 역굽힘), 오른손은 **+Z**가 커브.
      - ⚠️ `fingerDir × (index→little)`로 손바닥 법선을 구하려 하지 말 것 — 좌우가 거울이라 **부호가 뒤집혀서** 한쪽은 손등이 나온다. 양손 모두 −Y로 두면 된다.
    - **검증**: `tests/handTracking.test.ts`(엄지 밀림 매핑, 손가락 이름, 커브 부호, 손목 roll 출처, world visibility 병합, blendshape 거울) + **`tests/realAvatarHands.test.ts`(실제 `avatar.vrm`을 Node에서 로드해 "주먹 쥐면 손끝이 손바닥 쪽으로 간다"를 기하학적으로 검증)**. 후자가 이 버그를 잡는 테스트다 — DOM/URL 스텁을 조금 넣으면 Node에서 `.vrm`을 파싱할 수 있다(`node --test`는 파일별 프로세스라 스텁이 새지 않는다).
      - **⚠️ 테스트 교훈 2가지.** ① **거리는 방향이 아니다** — "주먹 쥐면 손끝~손목 거리가 짧아진다"로 검증했더니 **뒤로 꺾여도 똑같이 짧아져서**(실측 0.110 vs 0.103) 부호가 반대인 코드가 통과했다. ② **내가 추론한 값을 그대로 테스트에 박으면 테스트가 버그를 보증한다** — 손가락 부호를 소스 clamp 범위에서 추론해 테스트에 넣었고, 그 테스트가 통과하는 채로 실기기에서 역굽힘이 났다. 지금은 실제 모델 지오메트리를 기준으로 삼는다.
    - **실기기 1차 피드백 반영 완료 (2026-08-06)**: ARKit 이름·손 handedness는 실제로 동작 확인됨(손가락·표정 모두 반응). 고쳐야 했던 건 위의 **부위별 게이팅**과 **거울 방향(머리 roll, 윙크/시선)** 2건. 남은 미검증은 **모델 3개 동시 추론 FPS** — 느리면 `upper`에서 pose를 `lite`로 내리거나 `HAND_EVERY_N_FRAMES`를 3으로 올릴 것.
    - **팔꿈치가 화면을 벗어날 때**: 어깨만 보이면 상완은 따라오지만 하완 추정이 나빠질 수 있다. 그때의 다음 수단은 **손 위치로 팔을 IK 배치**하는 것(2본 IK: 어깨→손목 목표, 팔꿈치는 힌트 축으로 해석). 지금은 필요 없어서 넣지 않았다 — 팔은 이미 pose로 추적되고 있었고 문제는 게이팅이었다.
  - **⚠️ 부위별 게이팅 — 전역 return 금지 (2026-08-06 실기기 버그 수정)**: 예전엔 "엉덩이 visibility < 0.3이면 **전체 포즈 스킵**"이었는데, 얼굴+손 프레이밍에선 카메라에 가까이 앉아 골반이 화면 밖이라 **팔까지 통째로 얼어붙었다**(어깨·팔꿈치는 완벽히 추적되는데 아바타는 T포즈 유지, 손가락과 얼굴만 움직임). 지금은 `lib/vrm/boneRig.ts`의 `resolvePoseGates`가 부위마다 필요한 랜드마크로 판단한다 — **팔은 어깨 ≥ 0.5**, 몸통(hips/spine)은 골반 ≥ 0.3(골반 없이 추정하면 아바타가 저절로 기운다), 다리는 `full` 모드 + 무릎 > 0.4. `tests/handTracking.test.ts`의 "hidden hips must not freeze the arms"가 이 회귀를 고정한다. **다시 전역 early-return으로 되돌리지 말 것.**
  - **⚠️ 얼굴 회전은 X(pitch)·Z(roll) 둘 다 반전 (`rigFaceRotation`)**: 고개를 내리면 아바타가 위를 보던 문제. Kalidokit head는 VRM0 raw 본 규약이고 VRM0→VRM1은 **Y축 180° 회전**이라, 회전을 그 변환으로 conjugate하면 **X와 Z 성분이 부호 반전**된다(Y는 살아남는다). 그래서 얼굴 전용 헬퍼로 x·z만 반전하고 yaw는 건드리지 않는다. (팔은 실측 결과 Z만 반전이면 맞다 — Kalidokit `rigArm`이 자체적으로 좌우 부호를 섞기 때문. 얼굴과 팔의 규칙이 다른 게 정상이다.)
  - **⚠️ 엄지는 Kalidokit 출력을 안 쓴다 (`solveThumbRig`)**: Kalidokit 엄지 분기는 VRM0 이름 기준으로 튜닝된 상수 덩어리다(`startPos.x`만 **1.2rad ≈ 69°**). VRM 1.0이 엄지 체인을 한 관절 밀어놨으니 그 상수가 엉뚱한 관절에 얹혀 **엄지만 혼자 꺾인다**. 실측하니 엄지도 **왼손 −Z / 오른손 +Z**로 손바닥 쪽으로 굽으므로(나머지 네 손가락과 동일 축·부호) 같은 공식(정규화 관절각 × −π × invert, gain 0.7)으로 직접 계산한다. 상수 오프셋 없음.
  - **⚠️ 거울 방향 (2026-08-06 실기기 수정)**: ① **머리 roll(고개 까딱)도 Z 반전**이 필요했다 — 예전엔 "Face.solve는 다른 규약이라 그대로 둔다"였지만 실제로는 몸과 같이 뒤집혀 있었다. 이제 이 파일의 **솔버 유래 본은 전부 flipZ**(예외 없는 한 가지 규칙). ② **윙크/시선 좌우 스왑**: ARKit 이름은 해부학 기준(`eyeBlinkLeft` = 본인의 왼눈)인데 아바타는 거울상이라, 왼눈을 감으면 화면에서 같은 쪽에 있는 아바타의 **오른눈**이 감겨야 한다. `faceExpressions.ts`에서 좌우를 교차시킨다(Kalidokit 폴백 경로도 동일). 수평 시선(`lookLeft/Right`)도 같은 이유로 교차.
  - **안정화**: 각 본에 deadzone(0.02rad ≈ 1.1°) + slerp 스무딩(body 0.3 / leg 0.22 / face 0.3). 표정은 blink(`clampThreshold 0.15~0.85`) + 모음 5종(`aa/ih/ou/ee/oh`, cutoff 0.08).
  - **UI**: 3D 아바타가 히어로 스테이지, 실제 카메라는 우상단 **PiP**(`CameraView`에 `showControls={false}`·`allowSwitch={false}`)로 겹쳐서 **둘을 한 화면에서 동시에** 본다. 3D 카메라는 뒤로 빼고 시선을 가슴 높이로 맞춰 든 팔이 프레임에 남게 함. 스냅샷 → 결과 모달(아바타·FPS·트래킹 센서) → `ResultActions`로 공유/저장.

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

- **HeartPulse 심박 정확도**: 위 3번 항목이 **여전히 미해결**된 최우선 과제. (VrmMotion 작업이 먼저 들어와서 밀렸음.)
- **VrmMotion 실기기 확인**: 축 매핑은 `?debug` 축 스윕 + `applyTrackingToVRM` end-to-end로 수치 검증됨(측면 들기 dY −0.60→+0.615, 전방 들기 +0.167→+0.435). 남은 건 실제 웹캠에서의 체감 — 좌우 거울 방향, 다리/허리 흔들림, 모바일 FPS(pose full 모델 부담), 20초 flush로 vrmmotion 클립이 B2에 실제로 쌓이는지.
- **실제 기기(진짜 웹캠)로 테스트**: 이 프로젝트를 다루는 Claude 세션은 샌드박스 브라우저라 실제 카메라 접근이 정책상 막혀 있어 직접 테스트 불가능. 사용자가 실제 폰/노트북으로 열어봐야 함. 콘솔 에러 있으면 붙여넣어 달라고 요청하면 됨.
- **오디오 녹음 실기기 확인**: 권한창에 마이크가 함께 뜨는지, 업로드 파일에 소리가 들어가는지.

## 폴더 이력

원래 `C:\skill_prac`에서 작업하다가 여러 번 이전, 현재 이 PC의 경로는 `C:\GitHub\WebCam`(GitHub Desktop 클론). 다른 컴퓨터에선 경로가 다르므로 경로 자체에 의존하지 말 것 — 리포는 `GaMaius/WebCam`의 `visionlab` 브랜치. `node_modules`/`.next`는 각 기기에서 `npm install`로 새로 생성.
