"use client";

import { useCallback, useRef } from "react";
import { ModuleShell } from "@/components/ModuleShell";
import { CameraView, type CameraHandle } from "@/components/CameraView";
import { Card } from "@/components/Card";
import { Waveform } from "@/components/Waveform";
import { useHeartPulseScan } from "@/hooks/useHeartPulseScan";
import styles from "./page.module.css";

const STEPS = ["카메라 정렬", "15초 스캔", "결과 리포트"];

function stepForPhase(phase: string): number {
  if (phase === "scanning") return 1;
  if (phase === "analyzing" || phase === "done" || phase === "error") return 2;
  return 0;
}

export default function HeartPulsePage() {
  const scan = useHeartPulseScan();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const handleCameraReady = useCallback(
    (handle: CameraHandle) => {
      videoRef.current = handle.video;
      void scan.start(handle.video);
    },
    [scan]
  );

  const handleRetry = useCallback(() => {
    if (videoRef.current) {
      void scan.start(videoRef.current);
    } else {
      scan.reset();
    }
  }, [scan]);

  return (
    <ModuleShell
      eyebrow="rPPG · 생체 신호"
      title="HeartPulse"
      accent="#f78ca0"
      steps={STEPS}
      activeStep={stepForPhase(scan.phase)}
    >
      <CameraView
        initialFacing="user"
        guide="face"
        guideHint={
          scan.phase === "aligning"
            ? "이마와 양 뺨이 가이드 안에 들어오도록 정렬하세요"
            : undefined
        }
        recordModule="heartpulse"
        autoStart
        onReady={handleCameraReady}
      />

      {scan.phase === "aligning" && (
        <Card className={styles.statusCard}>
          <span className={styles.spinner} />
          얼굴을 찾는 중입니다 — 가이드 안에 얼굴을 맞춰주세요.
        </Card>
      )}

      {scan.phase === "scanning" && (
        <Card className={styles.scanCard}>
          <div className={styles.progressRow}>
            <span>측정 중...</span>
            <span className="vl-mono">{Math.round(scan.progress * 15)}s / 15s</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${scan.progress * 100}%` }} />
          </div>
          <Waveform values={scan.waveform} color="#f78ca0" />
          <p className={styles.holdStill}>측정이 끝날 때까지 머리를 움직이지 마세요.</p>
        </Card>
      )}

      {scan.phase === "analyzing" && (
        <Card className={styles.statusCard}>
          <span className={styles.spinner} />
          측정 신호를 분석하고 있습니다...
        </Card>
      )}

      {scan.phase === "done" && scan.result && (
        <Card className={styles.resultCard}>
          <div className={styles.resultHeader}>
            <h3 className={styles.resultTitle}>측정 결과</h3>
            <span className={styles.engineTag}>
              {scan.engine === "deepphys" ? "DeepPhys AI 모델" : "POS 신호처리"}
            </span>
          </div>
          <div className={styles.statGrid}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>심박수</span>
              <span className={styles.statValue}>
                {scan.result.bpm}
                <span className={styles.statUnit}>BPM</span>
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>스트레스 지수</span>
              <span className={styles.statValue}>
                {scan.result.stressIndex}
                <span className={styles.statUnit}>/100</span>
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>측정 신뢰도</span>
              <span className={styles.statValue}>
                {scan.result.confidence}
                <span className={styles.statUnit}>%</span>
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>SDNN</span>
              <span className={styles.statValue}>
                {scan.result.sdnn}
                <span className={styles.statUnit}>ms</span>
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>RMSSD</span>
              <span className={styles.statValue}>
                {scan.result.rmssd}
                <span className={styles.statUnit}>ms</span>
              </span>
            </div>
          </div>
          <button className={styles.retryBtn} onClick={handleRetry}>
            다시 측정
          </button>
        </Card>
      )}

      {scan.phase === "error" && (
        <Card className={styles.errorCard}>
          <p>{scan.errorMessage}</p>
          <button className={styles.retryBtn} onClick={handleRetry}>
            다시 시도
          </button>
        </Card>
      )}

      <Card className={styles.info}>
        <h3 className={styles.infoTitle}>측정 준비</h3>
        <ul className={styles.tips}>
          <li>밝고 균일한 조명 아래에서 정면을 바라봐 주세요.</li>
          <li>측정 15초 동안 머리를 움직이지 않도록 유지합니다.</li>
          <li>이마·뺨의 미세한 혈류 변화로 심박(BPM)을 추정합니다.</li>
        </ul>
      </Card>
    </ModuleShell>
  );
}
