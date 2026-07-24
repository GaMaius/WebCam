import { ModuleCard } from "@/components/ModuleCard";
import { AppIcon } from "@/components/AppIcon";
import { APPS } from "@/lib/apps";
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
          카메라 하나로 나를 읽는 셀프 스캔 앱 모음이에요. 원하는 앱을 골라 측정하고,
          <strong> 결과를 이미지로 저장</strong>하세요. 앱은 계속 추가됩니다.
        </p>
      </header>

      <section className={styles.grid} aria-label="앱 목록">
        {APPS.map((app, i) => (
          <ModuleCard
            key={app.slug}
            href={`/${app.slug}`}
            index={String(i + 1).padStart(2, "0")}
            subtitle={app.subtitle}
            title={app.title}
            desc={app.desc}
            accent={app.accent}
            icon={<AppIcon name={app.icon} />}
            status={app.status}
          />
        ))}
      </section>

      <p className={styles.notice}>
        이 웹사이트는 별도의 서버가 없이 브라우저에서 처리되는 프론트 앱입니다.
      </p>

      <footer className={styles.footer}>
        <span className="vl-mono">VisionLab AI</span>
        <span>DeepPhys rPPG · MediaPipe · CIELAB</span>
      </footer>
    </main>
  );
}
