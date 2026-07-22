import Link from "next/link";
import styles from "./ModuleShell.module.css";

export function ModuleShell({
  eyebrow,
  title,
  accent = "var(--accent)",
  steps,
  activeStep,
  children,
}: {
  eyebrow: string;
  title: string;
  accent?: string;
  steps?: string[];
  activeStep?: number;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.wrap} style={{ "--m-accent": accent } as React.CSSProperties}>
      <header className={styles.header}>
        <Link href="/" className={styles.back} aria-label="홈으로">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
        </Link>
        <div className={styles.titles}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1 className={styles.title}>{title}</h1>
        </div>
      </header>

      {steps && steps.length > 0 && (
        <ol className={styles.steps}>
          {steps.map((label, i) => {
            const state =
              activeStep === undefined
                ? "idle"
                : i < activeStep
                ? "done"
                : i === activeStep
                ? "active"
                : "idle";
            return (
              <li key={label} className={`${styles.step} ${styles[state]}`}>
                <span className={styles.stepNum}>{i + 1}</span>
                <span className={styles.stepLabel}>{label}</span>
              </li>
            );
          })}
        </ol>
      )}

      <div className={styles.content}>{children}</div>
    </div>
  );
}
