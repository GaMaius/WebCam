"use client";

import React, { useRef } from "react";
import type { BgStyle } from "@/lib/vrm/vrmScene";

interface VrmControlPanelProps {
  bgStyle: BgStyle;
  onBgStyleChange: (style: BgStyle) => void;
  onCustomVrmUpload: (file: File) => void;
  vrmName: string;
  isCustomLoaded: boolean;
  onResetDefault: () => void;
  onTakeSnapshot: () => void;
  fps: number;
}

export function VrmControlPanel({
  bgStyle,
  onBgStyleChange,
  onCustomVrmUpload,
  vrmName,
  isCustomLoaded,
  onResetDefault,
  onTakeSnapshot,
  fps,
}: VrmControlPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.name.toLowerCase().endsWith(".vrm")) {
        onCustomVrmUpload(file);
      } else {
        alert(".vrm 포맷의 3D 아바타 파일만 업로드할 수 있습니다.");
      }
    }
  };

  return (
    <div className="bg-[#161824]/90 backdrop-blur-md border border-white/10 rounded-2xl p-4 sm:p-5 flex flex-col gap-4 text-white">
      {/* Header Info */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs uppercase tracking-wider text-[#92A9E1] font-semibold">
            Active Avatar
          </span>
          <h3 className="text-lg font-bold truncate max-w-[200px] sm:max-w-[300px]">
            {vrmName}
          </h3>
        </div>
        <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-1.5 rounded-full text-xs font-mono text-emerald-400">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          {Math.round(fps)} FPS
        </div>
      </div>

      <hr className="border-white/10" />

      {/* Controls Group */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Background Setting */}
        <div>
          <label className="text-xs font-medium text-white/60 mb-1.5 block">
            배경 모드 (Studio / Chroma)
          </label>
          <div className="grid grid-cols-3 gap-1.5 p-1 bg-white/5 border border-white/10 rounded-xl">
            {(
              [
                { id: "dark", label: "스튜디오" },
                { id: "chromakey", label: "크로마키" },
                { id: "transparent", label: "투명" },
              ] as const
            ).map((mode) => (
              <button
                key={mode.id}
                onClick={() => onBgStyleChange(mode.id)}
                className={`py-1.5 text-xs font-medium rounded-lg transition-all ${
                  bgStyle === mode.id
                    ? "bg-[#7b52b9] text-white shadow-md"
                    : "text-white/70 hover:text-white hover:bg-white/5"
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom VRM Upload */}
        <div>
          <label className="text-xs font-medium text-white/60 mb-1.5 block">
            커스텀 .vrm 아바타
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".vrm"
            className="hidden"
            onChange={handleFileChange}
          />
          <div className="flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex-1 py-1.5 px-3 bg-white/10 hover:bg-white/20 border border-white/15 rounded-xl text-xs font-semibold text-white transition-all flex items-center justify-center gap-1.5"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </svg>
              .vrm 파일 불러오기
            </button>
            {isCustomLoaded && (
              <button
                onClick={onResetDefault}
                className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 rounded-xl text-xs font-medium transition-all"
                title="기본 아바타로 복원"
              >
                초기화
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Action Button */}
      <button
        onClick={onTakeSnapshot}
        className="w-full py-3 bg-gradient-to-r from-[#7b52b9] to-[#92A9E1] hover:brightness-110 text-white font-bold rounded-xl shadow-lg transition-all flex items-center justify-center gap-2"
      >
        <svg
          className="w-5 h-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 9a2 2 0 012-2h0.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
        현재 아바타 포즈 캡처 &amp; 리포트 생성
      </button>
    </div>
  );
}
