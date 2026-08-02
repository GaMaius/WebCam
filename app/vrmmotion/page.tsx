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

const ACCENT = "#7b52b9";

export default function VrmMotionPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<VrmCanvasRef | null>(null);

  const [currentVrm, setCurrentVrm] = useState<VRM | null>(null);
  const [vrmName, setVrmName] = useState("Constraint Sample (기본)");
  const [isCustomLoaded, setIsCustomLoaded] = useState(false);
  const [bgStyle, setBgStyle] = useState<BgStyle>("dark");

  const [capturedResult, setCapturedResult] = useState<VrmMotionResult | null>(null);
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">("user");

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
  };

  const handleRenderCard = useCallback(async () => {
    const canvas = document.createElement("canvas");
    if (capturedResult) {
      await drawVrmMotionCard(canvas, capturedResult);
    }
    return canvas;
  }, [capturedResult]);

  return (
    <ModuleShell
      eyebrow="3D · 모션캡쳐"
      title="VRM Capture"
      accent={ACCENT}
    >
      <div className="flex flex-col gap-6 max-w-6xl mx-auto w-full pb-12">
        {/* Main Grid: Camera View + VRM 3D Canvas */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          {/* Left: Camera Feed */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#92A9E1] flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                Live Camera Input
              </span>
              <button
                onClick={() =>
                  setCameraFacing((f) => (f === "user" ? "environment" : "user"))
                }
                className="text-xs text-white/70 hover:text-white bg-white/10 px-2.5 py-1 rounded-lg border border-white/10 transition-all"
              >
                {cameraFacing === "user" ? "후면 카메라 전환" : "전면 카메라 전환"}
              </button>
            </div>

            <div className="relative aspect-video sm:aspect-square rounded-2xl overflow-hidden bg-black/60 border border-white/10 shadow-lg">
              <CameraView
                autoStart={true}
                initialFacing={cameraFacing}
                onReady={handleCameraReady}
              />

              {/* Status Overlay */}
              <div className="absolute top-3 left-3 right-3 flex justify-between items-center pointer-events-none">
                <div className="bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full text-xs text-white border border-white/15 flex gap-2 items-center">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      isFaceTracked ? "bg-emerald-400" : "bg-white/30"
                    }`}
                  />
                  <span>Face</span>
                  <span
                    className={`w-2 h-2 rounded-full ${
                      isPoseTracked ? "bg-emerald-400" : "bg-white/30"
                    }`}
                  />
                  <span>Pose</span>
                </div>
                {isLoadingModels && (
                  <div className="bg-[#7b52b9]/90 text-white text-xs px-3 py-1.5 rounded-full backdrop-blur-md animate-pulse">
                    AI 모델 준비 중...
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: 3D VRM Canvas */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#92A9E1]">
                3D VRM Avatar View
              </span>
              <span className="text-xs text-white/50">
                마우스 / 터치로 카메라 회전 가능
              </span>
            </div>
            <div className="w-full aspect-video sm:aspect-square">
              <VrmCanvas
                ref={canvasRef}
                bgStyle={bgStyle}
                initialVrmUrl="/models/avatar.vrm"
                onVrmLoaded={handleVrmLoaded}
              />
            </div>
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
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto">
            <div className="bg-[#161824] border border-white/15 rounded-3xl p-6 max-w-lg w-full flex flex-col gap-5 shadow-2xl relative">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-[#7b52b9]">
                    VRM Capture Result
                  </span>
                  <h2 className="text-xl font-bold text-white">모션 캡쳐 스냅샷 리포트</h2>
                </div>
                <button
                  onClick={() => setCapturedResult(null)}
                  className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all"
                >
                  ✕
                </button>
              </div>

              {/* Preview Image */}
              <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-black/50 aspect-[4/3]">
                <img
                  src={capturedResult.snapshotDataUrl}
                  alt="Captured VRM Pose"
                  className="w-full h-full object-contain"
                />
              </div>

              {/* Stats Summary */}
              <div className="grid grid-cols-3 gap-2 bg-white/5 p-3 rounded-2xl border border-white/10 text-center">
                <div>
                  <div className="text-[11px] text-white/50">아바타</div>
                  <div className="text-xs font-bold text-white truncate">
                    {capturedResult.vrmName}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-white/50">프레임</div>
                  <div className="text-xs font-bold text-emerald-400">
                    {Math.round(capturedResult.fps || 0)} FPS
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-white/50">트래킹</div>
                  <div className="text-xs font-bold text-purple-300">
                    {capturedResult.faceTracked && capturedResult.poseTracked
                      ? "Face+Pose"
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
