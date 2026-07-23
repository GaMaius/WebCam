"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModuleShell } from "@/components/ModuleShell";
import { CameraView, type CameraHandle } from "@/components/CameraView";
import { Card } from "@/components/Card";
import { usePersonalFrameScan } from "@/hooks/usePersonalFrameScan";
import { SEASON_LABEL, UNDERTONE_LABEL, FACE_SHAPE_LABEL } from "@/lib/labels";
import styles from "./page.module.css";

const STEPS = ["원리 안내", "전면 · 후면 스캔", "톤 & 골격 진단"];

function stepForPhase(phase: string, introDone: boolean): number {
  if (!introDone) return 0;
  if (phase === "done" || phase === "error") return 2;
  return 1;
}

export default function PersonalFramePage() {
  const scan = usePersonalFrameScan();
  const lastHandleRef = useRef<CameraHandle | null>(null);
  const [introDone, setIntroDone] = useState(false);

  // Same rule as HeartPulse: the camera + background recording auto-start
  // unconditionally, but the actual front-camera skin capture only begins
  // once the user has acknowledged the how-it-works/how-to-hold card.
  const handleReady = useCallback(
    (handle: CameraHandle) => {
      lastHandleRef.current = handle;
      if (introDone) scan.handleCameraReady(handle);
    },
    [introDone, scan]
  );

  useEffect(() => {
    if (introDone && lastHandleRef.current && scan.phase === "idle") {
      scan.handleCameraReady(lastHandleRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introDone]);

  const handleStart = useCallback(() => setIntroDone(true), []);

  const handleRetry = useCallback(() => {
    scan.reset();
    if (lastHandleRef.current) scan.handleCameraReady(lastHandleRef.current);
  }, [scan]);

  const showFaceGuide = introDone && scan.phase !== "back-capturing" && scan.phase !== "done";

  return (
    <ModuleShell
      eyebrow="CIELAB · 스타일"
      title="PersonalFrame"
      accent="#4b6b3a"
      steps={STEPS}
      activeStep={stepForPhase(scan.phase, introDone)}
    >
      <CameraView
        initialFacing="user"
        guide={showFaceGuide ? "face" : "none"}
        guideHint={
          introDone && scan.phase === "front-aligning"
            ? "얼굴 전체가 가이드 안에 들어오도록 맞춰주세요"
            : undefined
        }
        recordModule="personalframe"
        autoStart
        onReady={handleReady}
      />

      {!introDone && (
        <Card className={styles.introCard}>
          <h3 className={styles.introTitle}>측정 전에 알아두세요</h3>
          <p className={styles.introPrinciple}>
            피부가 반사하는 빛의 색을 카메라로 읽어 CIELAB이라는 색 좌표로 변환합니다. 전면 카메라로 피부
            톤을, 후면 카메라로 주변 조명의 색을 측정해 조명에 따른 색 왜곡을 보정해요.
          </p>
          <ul className={styles.introTips}>
            <li>자연광이나 흰색 조명 아래에서 진행해주세요 — 노란 조명은 보정에 한계가 있어요.</li>
            <li>화장이나 필터 없이 맨 얼굴로 촬영하면 더 정확해요.</li>
            <li>전면 촬영 중에는 정면을 응시하고 고개를 움직이지 마세요.</li>
            <li>후면 전환 안내가 뜨면, 벽이나 바닥처럼 무늬 없는 곳에 카메라를 2초간 가만히 비춰주세요.</li>
          </ul>
          <button className={styles.startBtn} onClick={handleStart}>
            이해했어요, 측정 시작
          </button>
        </Card>
      )}

      {introDone && scan.phase === "front-aligning" && (
        <Card className={styles.statusCard}>
          <span className={styles.spinner} />
          얼굴을 찾는 중입니다 — 가이드 안에 얼굴을 맞춰주세요.
        </Card>
      )}

      {introDone && scan.phase === "front-capturing" && (
        <Card className={styles.scanCard}>
          <div className={styles.progressRow}>
            <span>전면 촬영 중... 정면을 응시하고 움직이지 마세요.</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${scan.progress * 100}%` }} />
          </div>
        </Card>
      )}

      {introDone && scan.phase === "awaiting-switch" && (
        <Card className={styles.switchCard}>
          <h3 className={styles.switchTitle}>후면 카메라로 전환해주세요</h3>
          <p className={styles.switchDesc}>
            주변 조명을 측정해 피부 톤의 색편향을 보정합니다. 카메라 화면의 <strong>카메라 전환</strong>{" "}
            버튼을 누른 뒤, 벽이나 바닥처럼 무늬 없는 곳에 카메라를 <strong>2초 정도</strong> 가만히 비춰주세요.
          </p>
          <button className={styles.skipBtn} onClick={scan.skipBackCapture}>
            후면 카메라 없이 진행
          </button>
        </Card>
      )}

      {introDone && scan.phase === "back-capturing" && (
        <Card className={styles.scanCard}>
          <div className={styles.progressRow}>
            <span>주변 조명 측정 중... 카메라를 가만히 유지해주세요.</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${scan.progress * 100}%` }} />
          </div>
        </Card>
      )}

      {introDone && scan.phase === "done" && scan.result && (
        <Card className={styles.resultCard}>
          <div className={styles.resultHeader}>
            <h3 className={styles.resultTitle}>측정 결과</h3>
            <span className={styles.confidenceTag}>측정 신뢰도 {scan.result.confidence}%</span>
          </div>

          {!scan.result.ambientCorrected && (
            <p className={styles.uncorrectedNote}>
              후면 카메라 조명 보정 없이 진행된 결과예요. 실제 피부 톤과 차이가 있을 수 있어요.
            </p>
          )}

          <div className={styles.swatchRow}>
            <span className={styles.swatch} style={{ background: scan.result.skinHex }} />
            <div className={styles.swatchInfo}>
              <span className={styles.swatchHex}>{scan.result.skinHex}</span>
              <span className={styles.swatchLab}>
                L {scan.result.lab.L} · a {scan.result.lab.a} · b {scan.result.lab.b}
              </span>
            </div>
          </div>

          <div className={styles.statGrid}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>언더톤</span>
              <span className={styles.statValue}>{UNDERTONE_LABEL[scan.result.undertone]}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>퍼스널 시즌</span>
              <span className={styles.statValue}>{SEASON_LABEL[scan.result.season]}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>얼굴형</span>
              <span className={styles.statValue}>{FACE_SHAPE_LABEL[scan.result.faceShape]}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>얼굴 길이/너비</span>
              <span className={styles.statValue}>{scan.result.metrics.lengthToWidth}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>턱 각도</span>
              <span className={styles.statValue}>
                {scan.result.metrics.jawAngle}
                <span className={styles.statUnit}>°</span>
              </span>
            </div>
          </div>

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
