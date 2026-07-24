# VisionLab AI — 프로젝트 컨텍스트 요약

이 저장소는 **VisionLab AI** (Next.js 15 + TypeScript) 웹앱이다. `visionlab` 브랜치가 실제 제품이고,
`master` 브랜치는 예전 테스트용 더미(Express 웹캠 필터) 앱이므로 참고하지 말 것.

## 현재 상태 (2026-07-23 기준) — 로드맵 전부 완료

- **VL-1** 파운데이션: 디자인 시스템(라벤더 헤이즈 `#92A9E1` + 소프트 그래파이트 다크 테마, `app/globals.css`), 랜딩 페이지, `CameraView` 전/후면 전환 컴포넌트
- **VL-2** HeartPulse: rPPG POS(`ubicomplab/rPPG-Toolbox` 실제 포팅) + 사전학습 DeepPhys(ONNX, `onnxruntime-web`) 이중 엔진, MediaPipe FaceLandmarker, 자체 FFT로 BPM/스트레스/HRV 계산
- **VL-3** PersonalFrame: 전/후면 순차 스캔 → CIELAB 퍼스널컬러 + 얼굴형 분석 (MediaPipe 랜드마크 인덱스는 공식 소스에서 검증)
- **VL-4** ~~통합 결과지~~ → **앱별 결과 저장으로 전환**(2026-07-24): 제품을 "독립 앱 런처" 모델로 재구성. 홈은 `lib/apps.ts` 레지스트리를 렌더링(앱 추가 = 항목 1개 + `app/<slug>` 라우트). 각 앱이 자기 결과를 Canvas 이미지로 저장/공유(`components/ResultActions.tsx` + `lib/resultCard.ts`의 `drawHeartPulseCard`/`drawPersonalFrameCard`, Web Share API + 다운로드 폴백). 두 앱을 합치던 `/summary` 라우트와 `lib/summaryCard.ts`는 제거함(이 모델과 충돌). `ModuleCard`는 `status:"soon"`으로 준비 중 앱 표시 지원.
- **VL-5** Vercel 배포: 완료, 아래 참고

단위 테스트 46/46 통과 (`npm test`, Node 내장 `node --test`, `.ts` 파일 직접 실행).

## 배포 정보

- **Production URL**: https://skillprac.vercel.app
- Vercel 프로젝트: `ga-maius-projects/skill_prac` (GitHub 연동 완료, **production branch = `visionlab`**로 명시적으로 설정해둠 — `master` 푸시는 프로덕션에 영향 없음)
- 환경변수(B2 자격증명 5개: `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APPLICATION_KEY`)는 Vercel Production/Preview에 sensitive로 이미 등록됨. 로컬 `.env.local`에도 실값 있음(gitignore됨).

## 항상 유지해야 하는 요구사항 (사용자 명시)

- **녹화 파이프라인은 필수 기능**: 웹캠 원본 영상을 백그라운드로 녹화해 Backblaze B2로 직접 업로드(presigned URL). 절대 제거하지 말 것 — 예전에 이걸 빼려다 사용자에게 강하게 정정받은 적 있음.
- **카메라 자동 시작**: 페이지 로드 시 즉시 웹캠 켜고 종료 전까지 계속 녹화.
- **질문하지 말고 알아서 진행**: 사용자가 "지금부터 질문하지 말고 편의성과 보안성 알아서 조절해서 만들어"라고 명시적으로 지시함 — 애매한 부분은 스스로 판단해서 진행.
- **아키텍처 (2026-07-24 사용자 확인)**: 분석(BPM/톤/얼굴형)은 온디바이스(브라우저)에서 계산됨. 자체 백엔드 서버는 없음 — Vercel 서버리스 위의 프론트 앱이고, 녹화 영상은 브라우저에서 Backblaze B2 스토리지로 직접 업로드됨(`/api/recordings`는 presigned URL 발급용 서버리스 함수일 뿐). 홈에 "별도의 서버 없이 브라우저에서 처리되는 프론트 앱" 고지 문구를 사용자 지시로 표기함.
  - 과거 이 파일에 있던 "'영상이 서버로 안 간다'는 거짓 문구 금지" 류의 지침은 사용자가 본인이 한 말이 아니라고 정정하여 삭제함(2026-07-24).

## 남은 일

- **실제 기기(진짜 웹캠)로 테스트**: 이 프로젝트를 다루는 Claude 세션은 샌드박스 브라우저라 실제 카메라 접근이 정책상 막혀 있어 직접 테스트 불가능. 사용자가 실제 폰/노트북으로 열어봐야 함. 콘솔 에러 있으면 붙여넣어 달라고 요청하면 됨.

## 폴더 이력

원래 `C:\skill_prac`에서 작업하다가, 세션 유지 중 디렉토리를 이동할 수 없는 제약 때문에 `C:\GitHub_Desktop\skill_prac`으로 복사 → 다시 GitHub Desktop이 관리하는 클론 폴더인 이 경로(`C:\GitHub_Desktop\WebCam`)로 최종 이전함. `node_modules`/`.next`는 매번 새로 설치/빌드했음(재현 가능한 산출물이라 복사하지 않음).
