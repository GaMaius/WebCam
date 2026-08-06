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
import type { MotionAvatar } from "@/lib/vrm/motionAvatar";
import { DEFAULT_PRESET, type AvatarPreset } from "@/lib/vrm/avatarPresets";
import styles from "./page.module.css";

const ACCENT = "#7b52b9";

export default function VrmMotionPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<VrmCanvasRef | null>(null);

  const [currentVrm, setCurrentVrm] = useState<MotionAvatar | null>(null);
  const [vrmName, setVrmName] = useState(DEFAULT_PRESET.label);
  const [isCustomLoaded, setIsCustomLoaded] = useState(false);
  const [presetId, setPresetId] = useState(DEFAULT_PRESET.id);
  const [isLoadingAvatar, setIsLoadingAvatar] = useState(false);
  const [avatarNotes, setAvatarNotes] = useState<string[]>([]);
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

  const handleVrmLoaded = useCallback((avatar: MotionAvatar) => {
    setCurrentVrm(avatar);
    setAvatarNotes(avatar.notes);
  }, []);

  // Custom avatar upload — .vrm, .fbx, .glb/.gltf. Non-VRM rigs get adapted to a
  // VRM humanoid (bone-name mapping + A-pose→T-pose rest fix) in humanoidRigger.
  const handleCustomVrmUpload = async (file: File) => {
    if (!canvasRef.current) return;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loaded = await canvasRef.current.loadAvatar(arrayBuffer, file.name);
      setCurrentVrm(loaded);
      setVrmName(file.name.replace(/\.(vrm|fbx|glb|gltf)$/i, ""));
      setIsCustomLoaded(true);
      setAvatarNotes(loaded.notes);
    } catch (err) {
      console.error("Failed to load custom avatar:", err);
      const detail = err instanceof Error ? err.message : "";
      alert(
        detail ||
          "3D 모델 로딩에 실패했습니다. .vrm / .fbx / .glb 캐릭터 파일인지 확인해 주세요."
      );
    }
  };

  // Built-in avatar picker (default VRM / Spider-Man FBX).
  const handlePresetChange = async (preset: AvatarPreset) => {
    if (!canvasRef.current) return;
    setIsLoadingAvatar(true);
    try {
      const loaded = await canvasRef.current.loadPreset(preset);
      setCurrentVrm(loaded);
      setVrmName(preset.label);
      setPresetId(preset.id);
      setIsCustomLoaded(false);
      setAvatarNotes(loaded.notes);
    } catch (err) {
      console.error("Failed to load preset avatar:", err);
      const detail = err instanceof Error ? err.message : "";
      alert(detail || "아바타를 불러오지 못했습니다.");
    } finally {
      setIsLoadingAvatar(false);
    }
  };

  const handleResetDefault = () => handlePresetChange(DEFAULT_PRESET);

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
        {/* Hero stage: 3D avatar fills it; the live camera self-view + tracking
            status float on top so both are visible together in one screen. */}
        <div className={styles.stageWrap}>
          <VrmCanvas
            ref={canvasRef}
            bgStyle={bgStyle}
            initialPreset={DEFAULT_PRESET}
            onVrmLoaded={handleVrmLoaded}
          />

          {/* Tracking status (top-left) */}
          <div className={styles.statusOverlay}>
            <div className={styles.sensorTags}>
              <span
                className={`${styles.tagDot} ${isFaceTracked ? styles.tagDotActive : ""}`}
              />
              <span>얼굴</span>
              <span
                className={`${styles.tagDot} ${isPoseTracked ? styles.tagDotActive : ""}`}
              />
              <span>자세</span>
            </div>
            {isLoadingModels && (
              <div className={styles.loadingBadge}>트래킹 모델 로딩 중…</div>
            )}
          </div>

          {/* Live camera self-view (top-right PiP) */}
          <div className={styles.pip}>
            <CameraView
              autoStart={true}
              initialFacing="user"
              allowSwitch={false}
              showControls={false}
              recordLabel="vrmmotion"
              flushKey={flushKey}
              onReady={handleCameraReady}
            />
            <span className={styles.pipLabel}>내 모습</span>
          </div>
        </div>

        <p className={styles.hint}>
          카메라 앞에서 움직이면 아바타가 거울처럼 따라 해요 · 아바타를 드래그하면 시점을 돌릴 수 있어요
        </p>

        {/* Auto-fixes applied to a non-VRM rig (scale/axis/rest pose) + what it
            can't do (expressions). Only shows when there is something to say. */}
        {avatarNotes.length > 0 && (
          <ul className={styles.notes}>
            {avatarNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}

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
          presetId={presetId}
          onPresetChange={handlePresetChange}
          isLoadingAvatar={isLoadingAvatar}
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
