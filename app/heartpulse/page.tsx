"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModuleShell } from "@/components/ModuleShell";
import { CameraView, type CameraHandle } from "@/components/CameraView";
import { Card } from "@/components/Card";
import { Waveform } from "@/components/Waveform";
import { InfoModal } from "@/components/InfoModal";
import { HeartPulseHowto } from "@/components/illustrations";
import {
  useHeartPulseScan,
  SCAN_DURATION_OPTIONS,
  DEFAULT_SCAN_DURATION,
  type ScanDurationSec,
} from "@/hooks/useHeartPulseScan";
import { ResultActions } from "@/components/ResultActions";
import { drawHeartPulseCard } from "@/lib/resultCard";
import { HEART_METRIC_INFO, HEART_DISCLAIMER } from "@/lib/guidance";
import styles from "./page.module.css";

const ACCENT = "#c4553a";

/** The middle step names the chosen scan length, so the header and the picker
 * can never disagree. */
const stepsFor = (seconds: number) => ["원리 안내", `${seconds}초 스캔`, "결과 리포트"];
const ONBOARD_KEY = "visionlab:heartpulse:onboarded";

function stepForPhase(phase: string, started: boolean): number {
  if (!started) return 0;
  if (phase === "aligning" || phase === "scanning") return 1;
  if (phase === "analyzing" || phase === "done" || phase === "error") return 2;
  return 1;
}

export default function HeartPulsePage() {
  const scan = useHeartPulseScan();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [started, setStarted] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  // Bumped when a scan reaches a terminal state, so CameraView finalizes +
  // uploads the recording as one file while the page is still active.
  const [flushKey, setFlushKey] = useState(0);
  const [duration, setDuration] = useState<ScanDurationSec>(DEFAULT_SCAN_DURATION);
  useEffect(() => {
    if (scan.phase === "done" || scan.phase === "error") setFlushKey((k) => k + 1);
  }, [scan.phase]);

  // First visit: auto-open the how-it-works modal. Returning visitors skip
  // it but can reopen anytime via the header "?" button.
  useEffect(() => {
    try {
      if (!localStorage.getItem(ONBOARD_KEY)) setModalOpen(true);
    } catch {
      setModalOpen(true);
    }
  }, []);

  // Camera + background recording auto-start on load; the measurement itself
  // only begins once the user chooses to start.
  const handleCameraReady = useCallback(
    (handle: CameraHandle) => {
      videoRef.current = handle.video;
      if (started && scan.phase === "idle") void scan.start(handle.video, duration);
    },
    [started, scan, duration]
  );

  useEffect(() => {
    if (started && videoRef.current && scan.phase === "idle") {
      void scan.start(videoRef.current, duration);
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
    setShowDetail(false);
    if (videoRef.current) void scan.start(videoRef.current, duration);
    else scan.reset();
  }, [scan, duration]);

  const cardCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderResultCard = useCallback((): HTMLCanvasElement => {
    if (!cardCanvasRef.current) cardCanvasRef.current = document.createElement("canvas");
    if (scan.result) drawHeartPulseCard(cardCanvasRef.current, scan.result, ACCENT);
    return cardCanvasRef.current;
  }, [scan.result]);

  return (
    <ModuleShell
      eyebrow="rPPG · 생체 신호"
      title="HeartPulse"
      accent="#c4553a"
      steps={stepsFor(duration)}
      activeStep={stepForPhase(scan.phase, started)}
      onHelp={() => setModalOpen(true)}
    >
      <InfoModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        accent="#c4553a"
        eyebrow="어떻게 측정하나요"
        title="얼굴 혈류로 심박을 읽어요"
        illustration={<HeartPulseHowto />}
        primaryLabel={!started ? "이해했어요, 측정 시작" : undefined}
        onPrimary={!started ? beginMeasurement : undefined}
      >
        <p>
          심장이 뛸 때마다 얼굴 피부의 혈류량이 미세하게 변하고, 그만큼 피부색도 아주 조금씩 달라져요.
          이 변화를 카메라로 추적해 심박수(BPM)와 자율신경 균형(스트레스)을 추정합니다.
          측정 시간은 15·30·60초 중에서 고를 수 있어요.
        </p>
        <ul className={styles.modalTips}>
          <li>밝고 균일한 조명 아래, 정면을 응시해 주세요 — 역광은 피해주세요.</li>
          <li>안경에 빛이 반사되면 잠시 벗는 것을 권장해요.</li>
          <li>측정 중에는 머리를 움직이지 마세요. 움직임이 클수록 신뢰도가 낮아져요.</li>
          <li>
            턱 아래 <strong>목(경동맥 부근)</strong>이 보이면 그 피부도 함께 측정에 사용돼요. 경동맥은
            피부 가까이 지나가서 맥동이 크게 잡힙니다.
          </li>
        </ul>
      </InfoModal>

      <CameraView
        initialFacing="user"
        guide={started ? "face" : "none"}
        guideHint={
          started && scan.phase === "aligning"
            ? "이마와 양 뺨이 가이드 안에 들어오도록 정렬하세요"
            : undefined
        }
        autoStart
        flushKey={flushKey}
        onReady={handleCameraReady}
      />

      {!started && (
        <Card className={styles.startCard}>
          <div>
            <h3 className={styles.startTitle}>측정 준비됐어요</h3>
            <p className={styles.startDesc}>
              밝은 곳에서 정면을 바라보고, 측정 시간 동안 움직이지 않으면 돼요.
              <br />
              <strong>턱 아래 목이 보이면</strong> 경동맥 부근 피부도 함께 측정에 사용됩니다 — 옷깃으로
              목을 가리지 않는 편이 좋아요.
            </p>
          </div>

          <div className={styles.durationPicker}>
            <span className={styles.durationLabel}>측정 시간</span>
            <div className={styles.durationOptions}>
              {SCAN_DURATION_OPTIONS.map((sec) => (
                <button
                  key={sec}
                  type="button"
                  className={sec === duration ? styles.durationOnActive : styles.durationOn}
                  onClick={() => setDuration(sec)}
                  aria-pressed={sec === duration}
                >
                  {sec}초
                </button>
              ))}
            </div>
            <p className={styles.durationHint}>
              길수록 정확해요. 심박수 분해능이 측정 시간에 반비례해서, 15초는 이론상 ±4 BPM,
              30초는 ±2 BPM, 60초는 ±1 BPM 수준입니다. 움직임·조명 노이즈도 긴 창에서 더 잘 상쇄돼요.
            </p>
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

      {started && (scan.phase === "idle" || scan.phase === "aligning") && (
        <Card className={styles.statusCard}>
          <span className={styles.spinner} />
          {scan.phase === "idle"
            ? "카메라를 연결하는 중입니다..."
            : "얼굴을 찾는 중입니다 — 가이드 안에 얼굴을 맞춰주세요."}
        </Card>
      )}

      {started && scan.phase === "scanning" && (
        <Card className={styles.scanCard}>
          <div className={styles.progressRow}>
            <span>측정 중...</span>
            <span className="vl-mono">
              {Math.round(scan.progress * duration)}s / {duration}s
            </span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${scan.progress * 100}%` }} />
          </div>
          <Waveform values={scan.waveform} color="#c4553a" />
          <p className={styles.holdStill}>측정이 끝날 때까지 머리를 움직이지 마세요.</p>
        </Card>
      )}

      {started && scan.phase === "analyzing" && (
        <Card className={styles.statusCard}>
          <span className={styles.spinner} />
          측정 신호를 분석하고 있습니다...
        </Card>
      )}

      {started && scan.phase === "done" && scan.result && (
        <Card className={styles.resultCard}>
          <div className={styles.resultHeader}>
            <h3 className={styles.resultTitle}>측정 결과</h3>
            <span className={styles.engineTag}>
              {scan.engine === "tscan" ? "TS-CAN 신경망 (UW Ubicomp Lab)" : "POS 신호처리 (폴백)"}
            </span>
          </div>

          {/* Reported rather than assumed: the neck only counts when it was
              actually visible skin for most of the scan. */}
          <p className={styles.regionNote}>
            {scan.neckUsed
              ? `측정 부위: 이마 · 양 뺨 · 목(경동맥) — ${duration}초`
              : `측정 부위: 이마 · 양 뺨 — ${duration}초 (목이 가려져 있어 제외됐어요)`}
          </p>

          <div className={styles.statGrid}>
            <ResultStat label="심박수" value={`${scan.result.bpm}`} unit="BPM" info={HEART_METRIC_INFO.bpm.short} />
            <ResultStat label="측정 신뢰도" value={`${scan.result.confidence}`} unit="%" info="측정 안정도(움직임·비트 수 기반)" />
            <ResultStat
              label="스트레스 지수"
              value={scan.result.stressIndex !== null ? `${scan.result.stressIndex}` : null}
              unit={scan.result.stressIndex !== null ? "/100" : undefined}
              info={HEART_METRIC_INFO.stress.short}
            />
            <ResultStat
              label="SDNN"
              value={scan.result.sdnn !== null ? `${scan.result.sdnn}` : null}
              unit={scan.result.sdnn !== null ? "ms" : undefined}
              info={HEART_METRIC_INFO.sdnn.short}
            />
            <ResultStat
              label="RMSSD"
              value={scan.result.rmssd !== null ? `${scan.result.rmssd}` : null}
              unit={scan.result.rmssd !== null ? "ms" : undefined}
              info={HEART_METRIC_INFO.rmssd.short}
            />
          </div>

          {scan.result.stressIndex === null && (
            <p className={styles.unavailableNote}>
              심장 박동이 충분히 안정적으로 잡히지 않아 스트레스·HRV는 계산하지 않았어요. 조명을 밝게 하고
              머리를 고정한 채 다시 측정하면 계산될 확률이 높아져요.
            </p>
          )}

          <button className={styles.detailToggle} onClick={() => setShowDetail((v) => !v)}>
            {showDetail ? "지표 설명 접기" : "이 수치들, 무슨 뜻인가요?"}
          </button>

          {showDetail && (
            <div className={styles.detailList}>
              <MetricDetail title="심박수 (BPM)" info={HEART_METRIC_INFO.bpm.detail} range={HEART_METRIC_INFO.bpm.range} />
              <MetricDetail title="스트레스 지수" info={HEART_METRIC_INFO.stress.detail} range={HEART_METRIC_INFO.stress.range} />
              <MetricDetail title="SDNN" info={HEART_METRIC_INFO.sdnn.detail} range={HEART_METRIC_INFO.sdnn.range} />
              <MetricDetail title="RMSSD" info={HEART_METRIC_INFO.rmssd.detail} range={HEART_METRIC_INFO.rmssd.range} />
              <p className={styles.disclaimer}>{HEART_DISCLAIMER}</p>
            </div>
          )}

          <ResultActions
            render={renderResultCard}
            filename={`visionlab-heartpulse-${Date.now()}.png`}
            shareTitle="VisionLab · HeartPulse 결과"
            shareText="VisionLab으로 측정한 나의 심박·스트레스 결과예요."
          />

          <button className={styles.retryBtn} onClick={handleRetry}>
            다시 측정
          </button>
        </Card>
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

function ResultStat({
  label,
  value,
  unit,
  info,
}: {
  label: string;
  value: string | null;
  unit?: string;
  info: string;
}) {
  return (
    <div className={`${styles.stat} ${value === null ? styles.statUnavailable : ""}`}>
      <span className={styles.statLabel}>{label}</span>
      {value !== null ? (
        <span className={styles.statValue}>
          {value}
          {unit && <span className={styles.statUnit}>{unit}</span>}
        </span>
      ) : (
        <span className={styles.statValueMuted}>측정 불가</span>
      )}
      <span className={styles.statDesc}>{info}</span>
    </div>
  );
}

function MetricDetail({ title, info, range }: { title: string; info: string; range?: string }) {
  return (
    <div className={styles.detailItem}>
      <div className={styles.detailHead}>
        <span className={styles.detailTitle}>{title}</span>
        {range && <span className={styles.detailRange}>{range}</span>}
      </div>
      <p className={styles.detailText}>{info}</p>
    </div>
  );
}
