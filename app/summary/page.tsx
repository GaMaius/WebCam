"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ModuleShell } from "@/components/ModuleShell";
import { Card } from "@/components/Card";
import {
  SESSION_KEYS,
  type HeartPulseResult,
  type PersonalFrameResult,
} from "@/lib/types";
import { SEASON_LABEL, UNDERTONE_LABEL, FACE_SHAPE_LABEL } from "@/lib/labels";
import { drawSummaryCard, canvasToPngBlob } from "@/lib/summaryCard";
import styles from "./page.module.css";

export default function SummaryPage() {
  const [heart, setHeart] = useState<HeartPulseResult | null>(null);
  const [frame, setFrame] = useState<PersonalFrameResult | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [exportState, setExportState] = useState<"idle" | "working" | "error">("idle");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    try {
      const h = sessionStorage.getItem(SESSION_KEYS.heartPulse);
      const f = sessionStorage.getItem(SESSION_KEYS.personalFrame);
      if (h) setHeart(JSON.parse(h));
      if (f) setFrame(JSON.parse(f));
    } catch {
      /* ignore malformed session data */
    }
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  const hasAny = heart || frame;

  const renderCard = useCallback((): HTMLCanvasElement => {
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    drawSummaryCard(
      canvasRef.current,
      { heart, frame },
      { season: SEASON_LABEL, undertone: UNDERTONE_LABEL, faceShape: FACE_SHAPE_LABEL }
    );
    return canvasRef.current;
  }, [heart, frame]);

  const handleSave = useCallback(async () => {
    setExportState("working");
    try {
      const canvas = renderCard();
      const blob = await canvasToPngBlob(canvas);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `visionlab-summary-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
      setExportState("idle");
    } catch (err) {
      console.error("summary card export failed:", err);
      setExportState("error");
    }
  }, [renderCard]);

  const handleShare = useCallback(async () => {
    setExportState("working");
    try {
      const canvas = renderCard();
      const blob = await canvasToPngBlob(canvas);
      const file = new File([blob], "visionlab-summary.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "VisionLab AI 통합 결과지",
          text: "VisionLab AI로 측정한 나의 결과예요.",
        });
      } else {
        await handleSave();
      }
      setExportState("idle");
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") {
        setExportState("idle");
        return;
      }
      console.error("summary card share failed:", err);
      setExportState("error");
    }
  }, [renderCard, handleSave]);

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
            <Stat label="언더톤" value={UNDERTONE_LABEL[frame.undertone] ?? frame.undertone} />
            <Stat label="시즌 톤" value={SEASON_LABEL[frame.season] ?? frame.season} />
            <Stat label="얼굴형" value={FACE_SHAPE_LABEL[frame.faceShape] ?? frame.faceShape} />
          </div>
        </Card>
      )}

      {hasAny && (
        <Card className={styles.exportCard}>
          <p className={styles.exportDesc}>
            두 결과를 하나의 이미지로 저장하거나 공유할 수 있어요.
          </p>
          <div className={styles.exportActions}>
            <button
              className={styles.exportBtn}
              onClick={handleSave}
              disabled={exportState === "working"}
            >
              이미지로 저장
            </button>
            {canShare && (
              <button
                className={`${styles.exportBtn} ${styles.exportBtnPrimary}`}
                onClick={handleShare}
                disabled={exportState === "working"}
              >
                공유하기
              </button>
            )}
          </div>
          {exportState === "error" && (
            <p className={styles.exportError}>이미지 생성에 실패했습니다. 다시 시도해주세요.</p>
          )}
        </Card>
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
