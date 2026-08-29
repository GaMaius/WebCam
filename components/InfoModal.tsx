"use client";

import { useEffect } from "react";
import styles from "./InfoModal.module.css";

/**
 * Lightweight, dependency-free modal used for the pre-measurement
 * how-it-works explainer. Closes on backdrop click and Escape; locks body
 * scroll while open. The accent drives the illustration + primary button so
 * each module keeps its own identity.
 */
export function InfoModal({
  open,
  onClose,
  accent = "var(--accent)",
  eyebrow,
  title,
  illustration,
  children,
  primaryLabel,
  onPrimary,
}: {
  open: boolean;
  onClose: () => void;
  accent?: string;
  eyebrow: string;
  title: string;
  illustration?: React.ReactNode;
  children: React.ReactNode;
  primaryLabel?: string;
  onPrimary?: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={styles.sheet}
        style={{ "--modal-accent": accent } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <button className={styles.close} onClick={onClose} aria-label="닫기">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        {illustration && <div className={styles.illustration}>{illustration}</div>}

        <span className={styles.eyebrow}>{eyebrow}</span>
        <h2 className={styles.title}>{title}</h2>

        <div className={styles.body}>{children}</div>

        {primaryLabel && (
          <button
            className={styles.primary}
            onClick={() => {
              onPrimary?.();
              onClose();
            }}
          >
            {primaryLabel}
          </button>
        )}
      </div>
    </div>
  );
}
