# VisionLab — 프로젝트 컨텍스트 요약

이 저장소는 **VisionLab** (Next.js 15 + TypeScript) 웹앱이다. `visionlab` 브랜치가 실제 제품이고,
`master` 브랜치는 예전 테스트용 더미(Express 웹캠 필터) 앱이므로 참고하지 말 것.

> **다른 컴퓨터/새 세션용 안내:** 이 파일이 프로젝트의 단일 컨텍스트 소스다(로컬 메모리는 기기 종속이라 공유 안 됨).
> 제품 컨셉 = **"카메라로 나를 스캔하는 독립 앱 모음"**(웰니스+스타일+재미). 홈은 `lib/apps.ts` 레지스트리를 렌더링하는
> 런처. 브랜드는 **"VisionLab"**로 통일됨(탭 타이틀·히어로 H1·푸터·결과 이미지·공유 문구 모두 "VisionLab", 2026-07-25).
> 개발: `npm run dev`(3000 사용 중이면 다른 포트), `npm run build`, `npm test`.

## 현재 상태 (2026-07-25 기준)

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

단위 테스트: `npm test`(Node 내장 `node --test`, `.ts` 직접 실행). `deepPhys.test.ts`는 `onnxruntime-web` 미설치 환경에서 import 에러로 실패할 수 있음(로직 무관, `npm install` 후 정상).

## 배포 정보

- **Production URL**: https://skillprac.vercel.app
- Vercel 프로젝트: `ga-maius-projects/skill_prac` (GitHub 연동 완료, **production branch = `visionlab`**로 명시적으로 설정해둠 — `master` 푸시는 프로덕션에 영향 없음)
- 환경변수(B2 자격증명 5개: `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APPLICATION_KEY`)는 Vercel Production/Preview에 sensitive로 이미 등록됨. 로컬 `.env.local`에도 실값 있음(gitignore됨).

## 항상 유지해야 하는 요구사항 (사용자 명시)

- **녹화 파이프라인은 필수 기능**: 웹캠 원본 영상을 백그라운드로 녹화해 Backblaze B2로 직접 업로드(presigned URL). 절대 제거하지 말 것 — 예전에 이걸 빼려다 사용자에게 강하게 정정받은 적 있음.
- **웹캠 사용 = 항상 녹화·업로드 (2026-07-24 사용자 지시)**: 별도의 지시가 없으면 이 웹에서 웹캠을 켜는 모든 순간은 항상 녹화되어 B2로 업로드되어야 함. 그래서 `CameraView`의 녹화는 **기본 ON(opt-out)** 이다 — `record` prop 기본값 `true`, 끄려면 명시적으로 `record={false}`. B2 키 라벨은 `recordLabel` 미지정 시 라우트 첫 세그먼트에서 자동 유도(`deriveRecordLabel`). `/api/recordings`는 고정 allowlist 대신 `^[a-z0-9-]{1,40}$` 포맷 검증만 하므로 **새 앱은 별도 배선 없이 자동으로 녹화·업로드됨**. 모든 카메라 접근은 반드시 `CameraView`를 통하게 유지할 것.
- **오디오도 기본 녹음 (2026-07-25 사용자 지시)**: `CameraView`가 마이크도 함께 캡처(`audio` prop 기본 `true`)해 녹화에 소리 포함. getUserMedia는 카메라+마이크를 한 번의 통합 프롬프트로 요청하고, 마이크가 거부/부재면 **비디오 전용으로 자동 폴백**(카메라는 항상 동작). MediaRecorder mime은 opus 포함 webm이라 오디오 트랙 자동 저장.
- **카메라 자동 시작 및 이탈/탭전환 시 녹화 연속성 유지 (2026-07-28 사용자 지시)**: 페이지 로드 시 즉시 웹캠을 켜고, `MediaRecorder`에 `timeslice(1000ms)`를 부여하여 탭 전환이나 타 앱 창 활성화 시에도 백그라운드 미디어 엔진이 끊김 없이 데이터를 모으도록 처리함. 탭 전환(`visibilitychange`)이나 창 이동 시 비디오 재생 정지를 자동 복구하며, 페이지 이동(`pagehide`/`beforeunload`/unmount) 시에도 `fetch`의 `keepalive: true` 옵션을 통해 B2 업로드가 끝각까지 완료되도록 유지함.
- **작업 완료 시 항상 커밋 & 푸시 진행 (2026-07-28 사용자 지시)**: 기능 구현이나 수정 작업이 완료되면 반드시 `git commit` 및 `git push origin visionlab`을 즉시 진행하여 Vercel 실기기 환경에 바로 반영되도록 함.
- **질문하지 말고 알아서 진행**: 사용자가 "지금부터 질문하지 말고 편의성과 보안성 알아서 조절해서 만들어"라고 명시적으로 지시함 — 애매한 부분은 스스로 판단해서 진행.
- **아키텍처 (2026-07-24 사용자 확인)**: 분석(BPM/톤/얼굴형)은 온디바이스(브라우저)에서 계산됨. 자체 백엔드 서버는 없음 — Vercel 서버리스 위의 프론트 앱이고, 녹화 영상은 브라우저에서 Backblaze B2 스토리지로 직접 업로드됨(`/api/recordings`는 presigned URL 발급용 서버리스 함수일 뿐). 홈에 "별도의 서버 없이 브라우저에서 처리되는 프론트 앱" 고지 문구를 사용자 지시로 표기함.
  - 과거 이 파일에 있던 "'영상이 서버로 안 간다'는 거짓 문구 금지" 류의 지침은 사용자가 본인이 한 말이 아니라고 정정하여 삭제함(2026-07-24).

## 알려진 문제 / 다음에 고칠 것 (2026-07-26, 실기기 테스트 피드백)

우선순위 높은 미해결 5건. 각 항목은 사용자가 실기기에서 관찰한 증상이며, 세션 샌드박스는 실제 카메라 접근이 막혀 있어 재현이 어렵다는 점 유의(로직·데이터 위주로 파고들 것).

1. **녹화 업로드 — 파일명 및 IP별 폴더 구분 (2026-07-28 수정됨)**:
   - **파일명 및 폴더 구조 수정**: `route.ts`의 B2 키를 `<label>/<YYYY-MM-DD>/<ip>/<HHMMSS>-<label>-<shortid>.<ext>`(모듈/날짜/IP/시간-모듈-ID)로 변경 → 날짜별 하위에 클라이언트 IP별 폴더로 저장됨. 예: `heartpulse/2026-07-28/123.45.67.89/143022-heartpulse-a1b2c3d4.webm`.
   - **분할은 감수(2026-07-26 사용자 재확인)**: 잠깐 "flush 후 재시작 제거"로 세션당 1파일을 시도했으나, 사용자가 **"웹캠이 켜져 있으면 그 순간들은 무조건 다 녹화"**를 우선함(재스캔·idle 포함). 그래서 flush 후 **재시작을 유지**(`CameraView` flushKey `useEffect`가 finalize→beginRecording) → 완료 후 idle/재스캔도 계속 녹화되고, 그만큼 파일이 여러 개로 나뉘는 건 **의도된 트레이드오프**. PersonalFrame 전/후면 2파일도 정상. 이 동작(전원=녹화)을 임의로 되돌리지 말 것.

2. **PokéMatch — 비인간형/구형 오탐 필터링 및 UI 정리 (2026-07-28 수정됨)**:
   - **조치 1**: 사람 얼굴 스캔 시 비인간형 형태(`fish`, `bug-wings`, `tentacles`, `armor`, `ball`, `blob`, `quadruped`) 및 오탐 쏠림 종(`jigglypuff`, `electrode`, `chi_yu`, `goldeen` 등)을 완전히 필터링/제외 처리(`NON_HUMAN_EXCLUDE_SHAPES`, `HUB_EXCLUDE_SLUGS`). 실제 캐릭터성 인간형/직립형 포켓몬 위주로 매칭되도록 개편.
   - **조치 2 (사용자 요청)**: `AI 정밀 4대 세부 분석 리포트` UI 섹션을 완전히 제거.

3. **HeartPulse — 심박 측정 정확도가 많이 떨어지는 듯**: (사용자 지시로 이제 착수) 실제 심박 대비 오차 큼. 점검 대상: DeepPhys 경로 실제 사용 여부/전처리, POS 폴백 빈도, 밴드패스·피크검출·`estimateBpmAndHrv`의 FFT 지배주파수 산출, 30초 창/프레임레이트 추정(`effectiveFps`), 조명·움직임 영향. 가능하면 알려진 BPM(맥박계)과 비교할 수 있게 사용자에게 기준값 요청.

4. **PersonalFrame — 턱 각도(jawAngle) 측정이 이상함 (2026-07-27 수정됨)**: `lib/faceShape.ts`의 `JAW_RIGHT/JAW_LEFT` 랜드마크 인덱스를 `172/397`(하부 중간)에서 `58/288`(MediaPipe 하악각 / Gonion 코너)로 변경하여 Chin(152) 기준 하악각 턱선 형성각이 비상식적 수치(130°~150°) 대신 정상 수치(70°~110°)로 계산되도록 보정함. `classifyFaceShape` 사각턱 임계값도 92°로 재조정.

5. **PersonalFrame — 결과 이미지 저장 내용이 너무 빈약함 (2026-07-27 수정됨)**: `lib/resultCard.ts`의 `drawPersonalFrameCard`를 완전 재설계함. 1080x1350 PNG 내 4개 카드 블록(피부 톤/시즌 요약, 어울리는/피해야 할 대표 컬러 팔레트 칩, 메이크업·헤어·액세서리·패션 스타일 연출 가이드, 얼굴형·길이/너비·턱선형성각 골격 지표)으로 확장하여 화면 결과와 동등한 풍부한 수준으로 생성.

## 남은 일 (기존)

- **실제 기기(진짜 웹캠)로 테스트**: 이 프로젝트를 다루는 Codex 세션은 샌드박스 브라우저라 실제 카메라 접근이 정책상 막혀 있어 직접 테스트 불가능. 사용자가 실제 폰/노트북으로 열어봐야 함. 콘솔 에러 있으면 붙여넣어 달라고 요청하면 됨.
- **오디오 녹음 실기기 확인**: 권한창에 마이크가 함께 뜨는지, 업로드 파일에 소리가 들어가는지.

## 폴더 이력

원래 `C:\skill_prac`에서 작업하다가 여러 번 이전, 현재 이 PC의 경로는 `C:\GitHub\WebCam`(GitHub Desktop 클론). 다른 컴퓨터에선 경로가 다르므로 경로 자체에 의존하지 말 것 — 리포는 `GaMaius/WebCam`의 `visionlab` 브랜치. `node_modules`/`.next`는 각 기기에서 `npm install`로 새로 생성.
