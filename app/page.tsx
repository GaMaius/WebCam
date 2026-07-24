import { ModuleCard } from "@/components/ModuleCard";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <header className={styles.hero}>
        <span className="vl-pill">
          <span className={styles.dot} /> Vision Wellness &amp; Style Lab
        </span>
        <h1 className={styles.title}>
          VisionLab <span className={styles.accent}>AI</span>
        </h1>
        <p className={styles.lede}>
          카메라 하나로 나를 읽는 셀프 스캔. <strong>심박·스트레스</strong>와{" "}
          <strong>퍼스널 컬러·얼굴 골격</strong>을 한 번에 측정하고, 매일의 컨디션과 스타일을
          기록해 나가세요.
        </p>
      </header>

      <section className={styles.grid} aria-label="분석 모듈">
        <ModuleCard
          href="/heartpulse"
          index="01"
          subtitle="rPPG · 생체 신호"
          title="HeartPulse"
          desc="전면 카메라로 30초간 얼굴 미세 혈류를 추적해 심박수(BPM)와 자율신경 스트레스 지수를 측정합니다."
          accent="#c4553a"
          icon={<PulseIcon />}
        />
        <ModuleCard
          href="/personalframe"
          index="02"
          subtitle="CIELAB · 스타일"
          title="PersonalFrame"
          desc="전·후면 순차 스캔으로 조명을 보정하고, 퍼스널 컬러 톤과 얼굴 골격·비율을 진단합니다."
          accent="#4b6b3a"
          icon={<PaletteIcon />}
        />
        <ModuleCard
          href="/summary"
          index="03"
          subtitle="Integrated"
          title="통합 결과지"
          desc="두 분석을 하나의 카드로 종합하고, 이미지로 저장·공유할 수 있는 리포트를 생성합니다."
          accent="#8c5a73"
          icon={<ReportIcon />}
        />
      </section>

      <footer className={styles.footer}>
        <span className="vl-mono">VisionLab AI</span>
        <span>DeepPhys rPPG · MediaPipe · CIELAB</span>
      </footer>
    </main>
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
