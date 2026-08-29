import styles from "./Card.module.css";

export function Card({
  children,
  className = "",
  as: Tag = "div",
  glow = false,
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
  glow?: boolean;
}) {
  return (
    <Tag className={`${styles.card} ${glow ? styles.glow : ""} ${className}`}>
      {children}
    </Tag>
  );
}
