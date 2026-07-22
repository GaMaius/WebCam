"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ModuleShell } from "@/components/ModuleShell";
import { Card } from "@/components/Card";
import {
  SESSION_KEYS,
  type HeartPulseResult,
  type PersonalFrameResult,
} from "@/lib/types";
import styles from "./page.module.css";

export default function SummaryPage() {
  const [heart, setHeart] = useState<HeartPulseResult | null>(null);
  const [frame, setFrame] = useState<PersonalFrameResult | null>(null);

  useEffect(() => {
    try {
      const h = sessionStorage.getItem(SESSION_KEYS.heartPulse);
      const f = sessionStorage.getItem(SESSION_KEYS.personalFrame);
      if (h) setHeart(JSON.parse(h));
      if (f) setFrame(JSON.parse(f));
    } catch {
      /* ignore malformed session data */
    }
  }, []);

  const hasAny = heart || frame;

  return (
    <ModuleShell eyebrow="Integrated" title="통합 결과지" accent="#a78bfa">
      {!hasAny && (
        <Card className={styles.empty}>
          <div className={styles.emptyIcon}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="3" width="16" height="18" rx="2" />
              <path d="M8 8h8M8 12h8M8 16h5" />
            </svg>
          </div>
          <h3>아직 분석 결과가 없어요</h3>
          <p>두 모듈을 먼저 측정하면 이곳에서 종합 리포트로 묶어 드립니다.</p>
          <div className={styles.emptyLinks}>
            <Link href="/heartpulse" className={styles.emptyLink}>
              HeartPulse 측정
            </Link>
            <Link href="/personalframe" className={styles.emptyLink}>
              PersonalFrame 측정
            </Link>
          </div>
        </Card>
      )}

      {heart && (
        <Card className={styles.block}>
          <span className={styles.blockTag} style={{ color: "#f78ca0" }}>
            HeartPulse
          </span>
          <div className={styles.stats}>
            <Stat label="심박수" value={`${heart.bpm}`} unit="BPM" />
            <Stat label="스트레스" value={`${heart.stressIndex}`} unit="/100" />
            <Stat label="신뢰도" value={`${heart.confidence}`} unit="%" />
          </div>
        </Card>
      )}

      {frame && (
        <Card className={styles.block}>
          <span className={styles.blockTag} style={{ color: "#92a9e1" }}>
            PersonalFrame
          </span>
          <div className={styles.stats}>
            <Stat label="언더톤" value={frame.undertone} />
            <Stat label="시즌 톤" value={frame.season} />
            <Stat label="얼굴형" value={frame.faceShape} />
          </div>
        </Card>
      )}

      {hasAny && (
        <p className={styles.pending}>
          Canvas 이미지 저장·공유 기능은 다음 단계에서 연결됩니다.
        </p>
      )}
    </ModuleShell>
  );
}

function Stat({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>
        {value}
        {unit && <span className={styles.statUnit}>{unit}</span>}
      </span>
    </div>
  );
}
