"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModuleShell } from "@/components/ModuleShell";
import { CameraView, type CameraHandle } from "@/components/CameraView";
import { Card } from "@/components/Card";
import { InfoModal } from "@/components/InfoModal";
import { PersonalFrameHowto } from "@/components/illustrations";
import { usePersonalFrameScan } from "@/hooks/usePersonalFrameScan";
import { ResultActions } from "@/components/ResultActions";
import { drawPersonalFrameCard } from "@/lib/resultCard";
import { SEASON_LABEL, UNDERTONE_LABEL, FACE_SHAPE_LABEL, ITA_LABEL } from "@/lib/labels";
import {
  SEASON_GUIDE,
  UNDERTONE_INFO,
  FACE_SHAPE_TIP,
  ITA_INFO,
  PERSONAL_COLOR_DISCLAIMER,
} from "@/lib/guidance";
import styles from "./page.module.css";

const STEPS = ["원리 안내", "전면 · 후면 스캔", "톤 & 골격 진단"];
const ONBOARD_KEY = "visionlab:personalframe:onboarded";

function stepForPhase(phase: string, started: boolean): number {
  if (!started) return 0;
  if (phase === "done" || phase === "error") return 2;
  return 1;
}

export default function PersonalFramePage() {
  const scan = usePersonalFrameScan();
  const lastHandleRef = useRef<CameraHandle | null>(null);
  const [started, setStarted] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(ONBOARD_KEY)) setModalOpen(true);
    } catch {
      setModalOpen(true);
    }
  }, []);

  const handleReady = useCallback(
    (handle: CameraHandle) => {
      lastHandleRef.current = handle;
      if (started) scan.handleCameraReady(handle);
    },
    [started, scan]
  );

  useEffect(() => {
    if (started && lastHandleRef.current && scan.phase === "idle") {
      scan.handleCameraReady(lastHandleRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  const beginMeasurement = useCallback(() => {
    try {
      localStorage.setItem(ONBOARD_KEY, "1");
    } catch {
      /* ignore */
    }
    setStarted(true);
  }, []);

  const handleRetry = useCallback(() => {
    scan.reset();
    if (lastHandleRef.current) scan.handleCameraReady(lastHandleRef.current);
  }, [scan]);

  const cardCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderResultCard = useCallback((): HTMLCanvasElement => {
    if (!cardCanvasRef.current) cardCanvasRef.current = document.createElement("canvas");
    if (scan.result)
      drawPersonalFrameCard(cardCanvasRef.current, scan.result, {
        season: SEASON_LABEL,
        undertone: UNDERTONE_LABEL,
        faceShape: FACE_SHAPE_LABEL,
        ita: ITA_LABEL,
      });
    return cardCanvasRef.current;
  }, [scan.result]);

  const showFaceGuide = started && scan.phase !== "back-capturing" && scan.phase !== "done";
  const guide = scan.result ? SEASON_GUIDE[scan.result.season] : null;

  return (
    <ModuleShell
      eyebrow="CIELAB · 스타일"
      title="PersonalFrame"
      accent="#4b6b3a"
      steps={STEPS}
      activeStep={stepForPhase(scan.phase, started)}
      onHelp={() => setModalOpen(true)}
    >
      <InfoModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        accent="#4b6b3a"
        eyebrow="어떻게 측정하나요"
        title="피부색과 조명을 함께 읽어요"
        illustration={<PersonalFrameHowto />}
        primaryLabel={!started ? "이해했어요, 측정 시작" : undefined}
        onPrimary={!started ? beginMeasurement : undefined}
      >
        <p>
          피부가 반사하는 빛의 색을 카메라로 읽어 CIELAB 색 좌표로 변환해요. 전면 카메라로 피부 톤을,
          후면 카메라로 주변 조명의 색을 측정해 조명에 따른 색 왜곡을 보정합니다.
        </p>
        <ul className={styles.modalTips}>
          <li>자연광이나 흰색 조명 아래에서 진행해주세요 — 노란 조명은 보정에 한계가 있어요.</li>
          <li>화장·필터 없이 맨 얼굴로 촬영하면 더 정확해요.</li>
          <li>전면 촬영 중에는 정면을 응시하고 고개를 움직이지 마세요.</li>
          <li>후면 전환 안내가 뜨면, 벽·바닥처럼 무늬 없는 곳에 카메라를 2초간 가만히 비춰주세요.</li>
        </ul>
      </InfoModal>

      <CameraView
        initialFacing="user"
        guide={showFaceGuide ? "face" : "none"}
        guideHint={
          started && scan.phase === "front-aligning"
            ? "얼굴 전체가 가이드 안에 들어오도록 맞춰주세요"
            : undefined
        }
        recordModule="personalframe"
        autoStart
        onReady={handleReady}
      />

      {!started && !modalOpen && (
        <Card className={styles.startCard}>
          <div>
            <h3 className={styles.startTitle}>측정 준비됐어요</h3>
            <p className={styles.startDesc}>전면으로 얼굴을, 이어서 후면으로 주변 조명을 촬영해요.</p>
          </div>
          <div className={styles.startActions}>
            <button className={styles.startBtn} onClick={beginMeasurement}>
              측정 시작
            </button>
            <button className={styles.linkBtn} onClick={() => setModalOpen(true)}>
              측정 방법 보기
            </button>
          </div>
        </Card>
      )}

      {started && scan.phase === "front-aligning" && (
        <Card className={styles.statusCard}>
          <span className={styles.spinner} />
          얼굴을 찾는 중입니다 — 가이드 안에 얼굴을 맞춰주세요.
        </Card>
      )}

      {started && scan.phase === "front-capturing" && (
        <Card className={styles.scanCard}>
          <div className={styles.progressRow}>
            <span>전면 촬영 중... 정면을 응시하고 움직이지 마세요.</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${scan.progress * 100}%` }} />
          </div>
        </Card>
      )}

      {started && scan.phase === "awaiting-switch" && (
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

      {started && scan.phase === "back-capturing" && (
        <Card className={styles.scanCard}>
          <div className={styles.progressRow}>
            <span>주변 조명 측정 중... 카메라를 가만히 유지해주세요.</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${scan.progress * 100}%` }} />
          </div>
        </Card>
      )}

      {started && scan.phase === "done" && scan.result && guide && (
        <>
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

            <div className={styles.seasonHead}>
              <span className={styles.seasonName}>{SEASON_LABEL[scan.result.season]}</span>
              <span className={styles.undertoneName}>{UNDERTONE_LABEL[scan.result.undertone]}</span>
            </div>
            <p className={styles.seasonSummary}>{guide.summary}</p>
            <p className={styles.undertoneNote}>{UNDERTONE_INFO[scan.result.undertone]}</p>

            <div className={styles.itaRow}>
              <div className={styles.itaHead}>
                <span className={styles.itaLabel}>ITA° · 피부 톤 깊이</span>
                <span className={styles.itaValue}>
                  {scan.result.ita}°<span className={styles.itaCat}>{ITA_LABEL[scan.result.itaCategory]}</span>
                </span>
              </div>
              <p className={styles.itaInfo}>{ITA_INFO}</p>
            </div>
          </Card>

          <Card className={styles.applyCard}>
            <h3 className={styles.applyTitle}>이 톤, 이렇게 활용하세요</h3>

            <div className={styles.applyBlock}>
              <span className={styles.applyLabel}>어울리는 색</span>
              <div className={styles.swatchStrip}>
                {guide.palette.map((c) => (
                  <div key={c.hex} className={styles.chip}>
                    <span className={styles.chipDot} style={{ background: c.hex }} />
                    {c.name}
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.applyBlock}>
              <span className={styles.applyLabel}>피하면 좋은 색</span>
              <div className={styles.swatchStrip}>
                {guide.avoid.map((c) => (
                  <div key={c.hex} className={`${styles.chip} ${styles.chipMuted}`}>
                    <span className={styles.chipDot} style={{ background: c.hex }} />
                    {c.name}
                  </div>
                ))}
              </div>
            </div>

            <dl className={styles.applyList}>
              <ApplyRow label="메이크업" value={guide.makeup} />
              <ApplyRow label="헤어" value={guide.hair} />
              <ApplyRow label="액세서리" value={`${guide.metal} 계열이 잘 어울려요.`} />
              <ApplyRow label="패션" value={guide.fashion} />
              <ApplyRow label="얼굴형" value={FACE_SHAPE_TIP[scan.result.faceShape]} />
            </dl>

            <div className={styles.metricRow}>
              <span>얼굴형 {FACE_SHAPE_LABEL[scan.result.faceShape]}</span>
              <span>길이/너비 {scan.result.metrics.lengthToWidth}</span>
              <span>턱 각도 {scan.result.metrics.jawAngle}°</span>
            </div>

            <p className={styles.disclaimer}>{PERSONAL_COLOR_DISCLAIMER}</p>

            <ResultActions
              render={renderResultCard}
              filename={`visionlab-personalframe-${Date.now()}.png`}
              shareTitle="VisionLab AI · PersonalFrame 결과"
              shareText="VisionLab AI로 진단한 나의 퍼스널 컬러·얼굴형 결과예요."
            />

            <button className={styles.retryBtn} onClick={handleRetry}>
              다시 측정
            </button>
          </Card>
        </>
      )}

      {started && scan.phase === "error" && (
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

function ApplyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.applyRow}>
      <dt className={styles.applyRowLabel}>{label}</dt>
      <dd className={styles.applyRowValue}>{value}</dd>
    </div>
  );
}
