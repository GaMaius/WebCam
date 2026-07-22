import Link from "next/link";
import styles from "./ModuleCard.module.css";

export function ModuleCard({
  href,
  index,
  title,
  subtitle,
  desc,
  icon,
  accent,
}: {
  href: string;
  index: string;
  title: string;
  subtitle: string;
  desc: string;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <Link
      href={href}
      className={styles.card}
      style={{ "--card-accent": accent } as React.CSSProperties}
    >
      <div className={styles.top}>
        <span className={styles.icon}>{icon}</span>
        <span className={styles.index}>{index}</span>
      </div>
      <div className={styles.body}>
        <span className={styles.subtitle}>{subtitle}</span>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.desc}>{desc}</p>
      </div>
      <span className={styles.cta}>
        시작하기
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </span>
    </Link>
  );
}
