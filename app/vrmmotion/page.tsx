"use client";

import { useCallback, useRef, useState } from "react";
import { ModuleShell } from "@/components/ModuleShell";
import { CameraView, type CameraHandle } from "@/components/CameraView";
import { ResultActions } from "@/components/ResultActions";
import { VrmCanvas, type VrmCanvasRef } from "@/components/vrm/VrmCanvas";
import { VrmControlPanel } from "@/components/vrm/VrmControlPanel";
import { useVrmMotionScan } from "@/hooks/useVrmMotionScan";
import { drawVrmMotionCard, VrmMotionResult } from "@/lib/resultCard";
import type { BgStyle } from "@/lib/vrm/vrmScene";
import type { VRM } from "@pixiv/three-vrm";
import styles from "./page.module.css";

const ACCENT = "#7b52b9";

export default function VrmMotionPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<VrmCanvasRef | null>(null);

  const [currentVrm, setCurrentVrm] = useState<VRM | null>(null);
  const [vrmName, setVrmName] = useState("Constraint Sample (기본)");
  const [isCustomLoaded, setIsCustomLoaded] = useState(false);
  const [bgStyle, setBgStyle] = useState<BgStyle>("dark");

  const [capturedResult, setCapturedResult] = useState<VrmMotionResult | null>(null);
  const [flushKey, setFlushKey] = useState(0);

  // Motion Tracking Hook
  const { isLoadingModels, fps, isFaceTracked, isPoseTracked } = useVrmMotionScan(
    currentVrm,
    videoRef
  );

  const handleCameraReady = useCallback((handle: CameraHandle) => {
    videoRef.current = handle.video;
  }, []);

  const handleVrmLoaded = useCallback((vrm: VRM) => {
    setCurrentVrm(vrm);
  }, []);

  // Custom VRM Upload
  const handleCustomVrmUpload = async (file: File) => {
    if (!canvasRef.current) return;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadedVrm = await canvasRef.current.loadVRM(arrayBuffer);
      setCurrentVrm(loadedVrm);
      setVrmName(file.name.replace(/\.vrm$/i, ""));
      setIsCustomLoaded(true);
    } catch (err) {
      console.error("Failed to load custom VRM:", err);
      alert("VRM 파일 로딩에 실패했습니다. 올바른 3D VRM 모델인지 확인해 주세요.");
    }
  };

  const handleResetDefault = async () => {
    if (!canvasRef.current) return;
    try {
      const loadedVrm = await canvasRef.current.loadVRM("/models/avatar.vrm");
      setCurrentVrm(loadedVrm);
      setVrmName("Constraint Sample (기본)");
      setIsCustomLoaded(false);
    } catch (err) {
      console.error("Failed to reset default VRM:", err);
    }
  };

  // Snapshot Capture
  const handleTakeSnapshot = () => {
    if (!canvasRef.current) return;
    const snapshotUrl = canvasRef.current.takeSnapshot();
    const result: VrmMotionResult = {
      snapshotDataUrl: snapshotUrl,
      vrmName,
      fps,
      faceTracked: isFaceTracked,
      poseTracked: isPoseTracked,
      measuredAt: new Date().toISOString(),
    };
    setCapturedResult(result);
    // Flush current recording clip to B2 immediately while page is active (iOS Safari safety)
    setFlushKey((k) => k + 1);
  };

  const handleRenderCard = useCallback(async () => {
    const canvas = document.createElement("canvas");
    if (capturedResult) {
      await drawVrmMotionCard(canvas, capturedResult);
    }
    return canvas;
  }, [capturedResult]);

  return (
    <ModuleShell eyebrow="3D · 모션캡쳐" title="VRM Capture" accent={ACCENT}>
      <div className={styles.container}>
        {/* Main Stack: Top Camera View -> Bottom 3D VRM Canvas */}
        <div className={styles.stack}>
          {/* Top: Live Camera Feed */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>
                <span className={styles.liveDot} />
                실시간 웹캠 입력
              </span>
              <span className={styles.switchBtn} style={{ cursor: "default" }}>
                카메라 전환은 화면 버튼으로
              </span>
            </div>

            <div className={styles.mediaFrame}>
              <CameraView
                autoStart={true}
                initialFacing="user"
                recordLabel="vrmmotion"
                flushKey={flushKey}
                onReady={handleCameraReady}
              />

              {/* Status Overlay */}
              <div className={styles.statusOverlay}>
                <div className={styles.sensorTags}>
                  <span
                    className={`${styles.tagDot} ${
                      isFaceTracked ? styles.tagDotActive : ""
                    }`}
                  />
                  <span>Face</span>
                  <span
                    className={`${styles.tagDot} ${
                      isPoseTracked ? styles.tagDotActive : ""
                    }`}
                  />
                  <span>Pose</span>
                </div>
                {isLoadingModels && (
                  <div className={styles.loadingBadge}>AI 트래킹 모델 로딩 중...</div>
                )}
              </div>
            </div>
          </div>

          {/* Bottom: 3D VRM Character Avatar */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>3D VRM 캐릭터 아바타</span>
              <span className={styles.switchBtn} style={{ cursor: "default" }}>
                마우스 드래그로 회전
              </span>
            </div>
            <VrmCanvas
              ref={canvasRef}
              bgStyle={bgStyle}
              initialVrmUrl="/models/avatar.vrm"
              onVrmLoaded={handleVrmLoaded}
            />
          </div>
        </div>

        {/* Control Panel */}
        <VrmControlPanel
          bgStyle={bgStyle}
          onBgStyleChange={setBgStyle}
          onCustomVrmUpload={handleCustomVrmUpload}
          vrmName={vrmName}
          isCustomLoaded={isCustomLoaded}
          onResetDefault={handleResetDefault}
          onTakeSnapshot={handleTakeSnapshot}
          fps={fps}
        />

        {/* Capture Result Modal */}
        {capturedResult && (
          <div className={styles.modalOverlay}>
            <div className={styles.modalContent}>
              <div className={styles.modalHeader}>
                <div>
                  <span className={styles.subText}>VRM Capture Result</span>
                  <h2 className={styles.modalTitle}>모션 캡쳐 스냅샷 리포트</h2>
                </div>
                <button
                  onClick={() => setCapturedResult(null)}
                  className={styles.closeBtn}
                >
                  ✕
                </button>
              </div>

              {/* Preview Image */}
              <div className={styles.previewImageFrame}>
                <img
                  src={capturedResult.snapshotDataUrl}
                  alt="Captured VRM Pose"
                  className={styles.previewImage}
                />
              </div>

              {/* Stats Summary */}
              <div className={styles.statsGrid}>
                <div>
                  <div className={styles.statLabel}>아바타</div>
                  <div className={styles.statVal}>{capturedResult.vrmName}</div>
                </div>
                <div>
                  <div className={styles.statLabel}>프레임</div>
                  <div className={styles.statVal} style={{ color: "#34d399" }}>
                    {Math.round(capturedResult.fps || 0)} FPS
                  </div>
                </div>
                <div>
                  <div className={styles.statLabel}>트래킹 센서</div>
                  <div className={styles.statVal} style={{ color: "#c084fc" }}>
                    {capturedResult.faceTracked && capturedResult.poseTracked
                      ? "Face + Pose"
                      : capturedResult.faceTracked
                      ? "Face"
                      : "Pose"}
                  </div>
                </div>
              </div>

              {/* Share & Download Actions */}
              <ResultActions
                render={handleRenderCard}
                filename={`vrm-capture-${Date.now()}.png`}
                shareTitle="VisionLab VRM 모션캡쳐 결과"
                shareText={`VisionLab 3D 모션캡쳐 앱에서 ${capturedResult.vrmName} 캐릭터 포즈를 캡처했습니다!`}
              />
            </div>
          </div>
        )}
      </div>
    </ModuleShell>
  );
}
