"use client";

import { useCallback, useRef } from "react";
import { ModuleShell } from "@/components/ModuleShell";
import { CameraView, type CameraHandle } from "@/components/CameraView";
import { Card } from "@/components/Card";
import { usePersonalFrameScan } from "@/hooks/usePersonalFrameScan";
import styles from "./page.module.css";

const STEPS = ["전면 · 얼굴 스캔", "후면 · 조명 보정", "톤 & 골격 진단"];

const SEASON_LABEL: Record<string, string> = {
  "spring-warm": "봄 웜톤",
  "summer-cool": "여름 쿨톤",
  "autumn-warm": "가을 웜톤",
  "winter-cool": "겨울 쿨톤",
};

const UNDERTONE_LABEL: Record<string, string> = {
  warm: "웜톤",
  cool: "쿨톤",
  neutral: "뉴트럴",
};

const FACE_SHAPE_LABEL: Record<string, string> = {
  oval: "타원형",
  round: "둥근형",
  square: "각진형",
  heart: "하트형",
  oblong: "긴 얼굴형",
  diamond: "다이아몬드형",
};

function stepForPhase(phase: string): number {
  if (phase === "awaiting-switch" || phase === "back-capturing") return 1;
  if (phase === "done" || phase === "error") return 2;
  return 0;
}

export default function PersonalFramePage() {
  const scan = usePersonalFrameScan();
  const lastHandleRef = useRef<CameraHandle | null>(null);

  const handleReady = useCallback(
    (handle: CameraHandle) => {
      lastHandleRef.current = handle;
      scan.handleCameraReady(handle);
    },
    [scan]
  );

  const handleRetry = useCallback(() => {
    scan.reset();
    if (lastHandleRef.current) scan.handleCameraReady(lastHandleRef.current);
  }, [scan]);

  const showFaceGuide = scan.phase !== "back-capturing" && scan.phase !== "done";

  return (
    <ModuleShell
      eyebrow="CIELAB · 스타일"
      title="PersonalFrame"
      accent="#92a9e1"
      steps={STEPS}
      activeStep={stepForPhase(scan.phase)}
    >
      <CameraView
        initialFacing="user"
        guide={showFaceGuide ? "face" : "none"}
        guideHint={scan.phase === "front-aligning" ? "얼굴 전체가 가이드 안에 들어오도록 맞춰주세요" : undefined}
        recordModule="personalframe"
        autoStart
        onReady={handleReady}
      />

      {scan.phase === "front-aligning" && (
        <Card className={styles.statusCard}>
          <span className={styles.spinner} />
          얼굴을 찾는 중입니다 — 가이드 안에 얼굴을 맞춰주세요.
        </Card>
      )}

      {scan.phase === "front-capturing" && (
        <Card className={styles.scanCard}>
          <div className={styles.progressRow}>
            <span>전면 촬영 중...</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${scan.progress * 100}%` }} />
          </div>
        </Card>
      )}

      {scan.phase === "awaiting-switch" && (
        <Card className={styles.switchCard}>
          <h3 className={styles.switchTitle}>후면 카메라로 전환해주세요</h3>
          <p className={styles.switchDesc}>
            주변 조명을 측정해 피부 톤의 색편향을 보정합니다. 카메라 화면의{" "}
            <strong>카메라 전환</strong> 버튼을 눌러주세요.
          </p>
          <button className={styles.skipBtn} onClick={scan.skipBackCapture}>
            후면 카메라 없이 진행
          </button>
        </Card>
      )}

      {scan.phase === "back-capturing" && (
        <Card className={styles.scanCard}>
          <div className={styles.progressRow}>
            <span>주변 조명 측정 중...</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${scan.progress * 100}%` }} />
          </div>
        </Card>
      )}

      {scan.phase === "done" && scan.result && (
        <Card className={styles.resultCard}>
          <h3 className={styles.resultTitle}>측정 결과</h3>

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

      {scan.phase === "error" && (
        <Card className={styles.errorCard}>
          <p>{scan.errorMessage}</p>
          <button className={styles.retryBtn} onClick={handleRetry}>
            다시 시도
          </button>
        </Card>
      )}

      <Card className={styles.info}>
        <h3 className={styles.infoTitle}>순차 스캔 방식</h3>
        <p className={styles.desc}>
          모바일 브라우저는 전·후면 카메라를 동시에 쓸 수 없어, 두 단계로 나눠 진행합니다.
        </p>
        <ol className={styles.flow}>
          <li>
            <strong>전면</strong> — 얼굴 3D 메쉬와 1차 피부 톤을 추출합니다.
          </li>
          <li>
            <strong>후면 전환</strong> — 주변 조명 색온도를 측정해 색편향을 보정(Gray World)합니다.
          </li>
          <li>
            <strong>최종 진단</strong> — 조명이 정규화된 CIELAB 톤과 얼굴 골격을 산출합니다.
          </li>
        </ol>
      </Card>
    </ModuleShell>
  );
}
