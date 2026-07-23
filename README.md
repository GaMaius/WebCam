# VisionLab AI

웹캠으로 **(1) 심박수·스트레스(rPPG)** 와 **(2) 퍼스널 컬러·얼굴 골격(CIELAB)** 을 측정하는 셀프 비전 스캔 웹 서비스.

측정 분석(BPM·톤·골격)은 브라우저(on-device)에서 수행됩니다. 촬영 원본 영상은 분석 품질 향상을 위해 서버(Backblaze B2)에 저장됩니다.

## 기술 스택

- **Next.js 14 (App Router) + TypeScript**
- MediaPipe Tasks Vision — Face Detection & Face Mesh (예정)
- rPPG POS 알고리즘 (TS 포팅) / `onnxruntime-web` (예정)
- Chart.js + HTML5 Canvas — 파형/결과 시각화 및 이미지 저장 (예정)

## 개발

```bash
npm install
npm run dev
# http://localhost:3000
```

카메라는 HTTPS 또는 `localhost`에서만 동작합니다. 배포 대상은 Vercel입니다.

## 구조

```
app/
  page.tsx            메인 랜딩 (모듈 3종 진입)
  heartpulse/         HeartPulse — rPPG 심박수/스트레스
  personalframe/      PersonalFrame — 순차 전/후면 스캔, CIELAB 톤·골격
  summary/            통합 결과지
components/
  CameraView.tsx      facingMode(전/후면) 전환 공통 카메라
  ModuleShell.tsx     모듈 공통 헤더 + 단계 인디케이터
  Card.tsx / ModuleCard.tsx
lib/
  types.ts            모듈 간 공유 결과 타입 (sessionStorage 연동)
```

## 진행 상황

- [x] **VL-1** 프로젝트 뼈대 · 디자인 시스템 · 랜딩/IA · 전·후면 카메라 컴포넌트
- [ ] **VL-2** HeartPulse (MediaPipe ROI → POS/FFT → BPM·HRV·스트레스)
- [ ] **VL-3** PersonalFrame (Gray World 조명 보정 → CIELAB 톤 · Face Mesh 골격)
- [ ] **VL-4** 통합 결과지 · Canvas 저장/공유
