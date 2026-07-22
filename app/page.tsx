import { ModuleCard } from "@/components/ModuleCard";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <header className={styles.hero}>
        <span className="vl-pill">
          <span className={styles.dot} /> 설치·로그인 없이 · 브라우저에서 즉시 분석
        </span>
        <h1 className={styles.title}>
          VisionLab <span className={styles.accent}>AI</span>
        </h1>
        <p className={styles.lede}>
          웹캠 한 대로 <strong>심박수·스트레스</strong>부터 <strong>퍼스널 컬러·얼굴 골격</strong>까지.
          rPPG 신호처리와 CIELAB 색공간 분석을 브라우저 안에서 수행하는 원스톱 비전 분석 플랫폼입니다.
        </p>
        <div className={styles.privacyNote}>
          <LockIcon />
          모든 영상 분석은 <strong>기기 안(on-device)</strong>에서 처리되며 서버로 전송·저장되지 않습니다.
        </div>
      </header>

      <section className={styles.grid} aria-label="분석 모듈">
        <ModuleCard
          href="/heartpulse"
          index="01"
          subtitle="rPPG · 생체 신호"
          title="HeartPulse"
          desc="전면 카메라로 15초간 얼굴 미세 혈류를 추적해 심박수(BPM)와 자율신경 스트레스 지수를 측정합니다."
          accent="#f78ca0"
          icon={<PulseIcon />}
        />
        <ModuleCard
          href="/personalframe"
          index="02"
          subtitle="CIELAB · 스타일"
          title="PersonalFrame"
          desc="전·후면 순차 스캔으로 조명을 보정하고, 퍼스널 컬러 톤과 얼굴 골격·비율을 진단합니다."
          accent="#92a9e1"
          icon={<PaletteIcon />}
        />
        <ModuleCard
          href="/summary"
          index="03"
          subtitle="Integrated"
          title="통합 결과지"
          desc="두 분석을 하나의 카드로 종합하고, 이미지로 저장·공유할 수 있는 리포트를 생성합니다."
          accent="#a78bfa"
          icon={<ReportIcon />}
        />
      </section>

      <footer className={styles.footer}>
        <span className="vl-mono">VisionLab AI</span>
        <span>rPPG-Toolbox · MediaPipe · CIELAB</span>
      </footer>
    </main>
  );
}

function LockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
function PulseIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </svg>
  );
}
function PaletteIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r="1.3" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r="1.3" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r="1.3" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r="1.3" fill="currentColor" />
      <path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1.1.9-2 2-2h2.4A4.6 4.6 0 0 0 22 10.4C22 5.7 17.5 2 12 2z" />
    </svg>
  );
}
function ReportIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}
