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
- **카메라 자동 시작**: 페이지 로드 시 즉시 웹캠 켜고 종료 전까지 계속 녹화.
- **질문하지 말고 알아서 진행**: 사용자가 "지금부터 질문하지 말고 편의성과 보안성 알아서 조절해서 만들어"라고 명시적으로 지시함 — 애매한 부분은 스스로 판단해서 진행.
- **아키텍처 (2026-07-24 사용자 확인)**: 분석(BPM/톤/얼굴형)은 온디바이스(브라우저)에서 계산됨. 자체 백엔드 서버는 없음 — Vercel 서버리스 위의 프론트 앱이고, 녹화 영상은 브라우저에서 Backblaze B2 스토리지로 직접 업로드됨(`/api/recordings`는 presigned URL 발급용 서버리스 함수일 뿐). 홈에 "별도의 서버 없이 브라우저에서 처리되는 프론트 앱" 고지 문구를 사용자 지시로 표기함.
  - 과거 이 파일에 있던 "'영상이 서버로 안 간다'는 거짓 문구 금지" 류의 지침은 사용자가 본인이 한 말이 아니라고 정정하여 삭제함(2026-07-24).

## 남은 일

- **실제 기기(진짜 웹캠)로 테스트**: 이 프로젝트를 다루는 Claude 세션은 샌드박스 브라우저라 실제 카메라 접근이 정책상 막혀 있어 직접 테스트 불가능. 사용자가 실제 폰/노트북으로 열어봐야 함. 콘솔 에러 있으면 붙여넣어 달라고 요청하면 됨.
- **PokéMatch 실기기 최종확인**: 실제 얼굴로 상위5 품질/일관성 확인(로직·자산은 검증됨). 로딩이 답답하면 fp16 재시도(현재 fp32) 또는 자산을 B2/CDN으로.
- **오디오 녹음 실기기 확인**: 권한창에 마이크가 함께 뜨는지, 업로드 파일에 소리가 들어가는지.

## 폴더 이력

원래 `C:\skill_prac`에서 작업하다가 여러 번 이전, 현재 이 PC의 경로는 `C:\GitHub\WebCam`(GitHub Desktop 클론). 다른 컴퓨터에선 경로가 다르므로 경로 자체에 의존하지 말 것 — 리포는 `GaMaius/WebCam`의 `visionlab` 브랜치. `node_modules`/`.next`는 각 기기에서 `npm install`로 새로 생성.
