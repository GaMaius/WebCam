"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModuleShell } from "@/components/ModuleShell";
import { CameraView, type CameraHandle } from "@/components/CameraView";
import { Card } from "@/components/Card";
import { Waveform } from "@/components/Waveform";
import { useHeartPulseScan } from "@/hooks/useHeartPulseScan";
import styles from "./page.module.css";

const STEPS = ["원리 안내", "15초 스캔", "결과 리포트"];

function stepForPhase(phase: string, introDone: boolean): number {
  if (!introDone) return 0;
  if (phase === "aligning" || phase === "scanning") return 1;
  if (phase === "analyzing" || phase === "done" || phase === "error") return 2;
  return 1;
}

export default function HeartPulsePage() {
  const scan = useHeartPulseScan();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [introDone, setIntroDone] = useState(false);

  // The camera (and its background recording) must auto-start on page load
  // regardless of the intro screen — only the *measurement* is gated behind
  // it, so handleCameraReady just remembers the handle until the user has
  // read the instructions and pressed start (or starts it immediately if the
  // user somehow dismisses the intro before the camera finishes acquiring).
  const handleCameraReady = useCallback(
    (handle: CameraHandle) => {
      videoRef.current = handle.video;
      if (introDone && scan.phase === "idle") void scan.start(handle.video);
    },
    [introDone, scan]
  );

  useEffect(() => {
    if (introDone && videoRef.current && scan.phase === "idle") {
      void scan.start(videoRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introDone]);

  const handleStart = useCallback(() => {
    setIntroDone(true);
  }, []);

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
      accent="#c4553a"
      steps={STEPS}
      activeStep={stepForPhase(scan.phase, introDone)}
    >
      <CameraView
        initialFacing="user"
        guide={introDone ? "face" : "none"}
        guideHint={
          introDone && scan.phase === "aligning"
            ? "이마와 양 뺨이 가이드 안에 들어오도록 정렬하세요"
            : undefined
        }
        recordModule="heartpulse"
        autoStart
        onReady={handleCameraReady}
      />

      {!introDone && (
        <Card className={styles.introCard}>
          <h3 className={styles.introTitle}>측정 전에 알아두세요</h3>
          <p className={styles.introPrinciple}>
            얼굴 피부 아래 혈관은 심장이 뛸 때마다 아주 미세하게 색이 바뀝니다. 이 변화를 카메라로 읽어
            심박수(BPM)와 자율신경 균형에서 오는 스트레스 지수를 계산해요.
          </p>
          <ul className={styles.introTips}>
            <li>밝고 균일한 조명 아래, 정면을 응시해 주세요 — 역광은 피해주세요.</li>
            <li>안경에 빛이 반사된다면 잠시 벗는 것을 권장해요.</li>
            <li>측정 15초 동안 머리를 움직이지 마세요. 움직임이 클수록 신뢰도가 낮아져요.</li>
          </ul>
          <button className={styles.startBtn} onClick={handleStart}>
            이해했어요, 측정 시작
          </button>
        </Card>
      )}

      {introDone && scan.phase === "aligning" && (
        <Card className={styles.statusCard}>
          <span className={styles.spinner} />
          얼굴을 찾는 중입니다 — 가이드 안에 얼굴을 맞춰주세요.
        </Card>
      )}

      {introDone && scan.phase === "scanning" && (
        <Card className={styles.scanCard}>
          <div className={styles.progressRow}>
            <span>측정 중...</span>
            <span className="vl-mono">{Math.round(scan.progress * 15)}s / 15s</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${scan.progress * 100}%` }} />
          </div>
          <Waveform values={scan.waveform} color="#c4553a" />
          <p className={styles.holdStill}>측정이 끝날 때까지 머리를 움직이지 마세요.</p>
        </Card>
      )}

      {introDone && scan.phase === "analyzing" && (
        <Card className={styles.statusCard}>
          <span className={styles.spinner} />
          측정 신호를 분석하고 있습니다...
        </Card>
      )}

      {introDone && scan.phase === "done" && scan.result && (
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
              <span className={styles.statLabel}>측정 신뢰도</span>
              <span className={styles.statValue}>
                {scan.result.confidence}
                <span className={styles.statUnit}>%</span>
              </span>
            </div>
            {scan.result.stressIndex !== null ? (
              <div className={styles.stat}>
                <span className={styles.statLabel}>스트레스 지수</span>
                <span className={styles.statValue}>
                  {scan.result.stressIndex}
                  <span className={styles.statUnit}>/100</span>
                </span>
              </div>
            ) : (
              <div className={styles.statUnavailable}>
                <span className={styles.statLabel}>스트레스 지수</span>
                <span className={styles.statValueMuted}>측정 불가</span>
              </div>
            )}
            {scan.result.sdnn !== null ? (
              <div className={styles.stat}>
                <span className={styles.statLabel}>SDNN</span>
                <span className={styles.statValue}>
                  {scan.result.sdnn}
                  <span className={styles.statUnit}>ms</span>
                </span>
              </div>
            ) : (
              <div className={styles.statUnavailable}>
                <span className={styles.statLabel}>SDNN</span>
                <span className={styles.statValueMuted}>측정 불가</span>
              </div>
            )}
            {scan.result.rmssd !== null ? (
              <div className={styles.stat}>
                <span className={styles.statLabel}>RMSSD</span>
                <span className={styles.statValue}>
                  {scan.result.rmssd}
                  <span className={styles.statUnit}>ms</span>
                </span>
              </div>
            ) : (
              <div className={styles.statUnavailable}>
                <span className={styles.statLabel}>RMSSD</span>
                <span className={styles.statValueMuted}>측정 불가</span>
              </div>
            )}
          </div>
          {scan.result.stressIndex === null && (
            <p className={styles.unavailableNote}>
              심장 박동이 충분히 안정적으로 잡히지 않아 스트레스 지수와 HRV는 계산하지 않았어요. 조명을
              밝게 하고 머리를 고정한 채 다시 측정하면 계산될 확률이 높아져요.
            </p>
          )}
          <button className={styles.retryBtn} onClick={handleRetry}>
            다시 측정
          </button>
        </Card>
      )}

      {introDone && scan.phase === "error" && (
        <Card className={styles.errorCard}>
          <p>{scan.errorMessage}</p>
          <button className={styles.retryBtn} onClick={handleRetry}>
            다시 시도
          </button>
        </Card>
      )}
    </ModuleShell>
  );
}
