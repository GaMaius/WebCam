"use client";

import React, { useRef } from "react";
import type { BgStyle } from "@/lib/vrm/vrmScene";
import styles from "./VrmControlPanel.module.css";

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
    <div className={styles.panel} style={{ backgroundColor: "#fffdf7", color: "#1c1f15" }}>
      {/* Header Info */}
      <div className={styles.panelHeader}>
        <div className={styles.avatarNameGroup}>
          <span className={styles.subText} style={{ color: "#7b52b9" }}>Active Avatar</span>
          <h3 className={styles.vrmTitle} style={{ color: "#1c1f15" }}>{vrmName}</h3>
        </div>
        <div className={styles.fpsBadge} style={{ color: "#059669" }}>
          <span className={styles.fpsDot} />
          {Math.round(fps)} FPS
        </div>
      </div>

      <hr className={styles.divider} />

      {/* Controls Group */}
      <div className={styles.controlGrid}>
        {/* Background Setting */}
        <div className={styles.fieldGroup}>
          <label className={styles.label} style={{ color: "#444838" }}>배경 모드 (Studio / Chroma)</label>
          <div className={styles.btnGroup} style={{ backgroundColor: "#fbf7ec" }}>
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
                className={`${styles.modeBtn} ${
                  bgStyle === mode.id ? styles.modeBtnActive : ""
                }`}
                style={{
                  color: bgStyle === mode.id ? "#ffffff" : "#444838",
                  backgroundColor: bgStyle === mode.id ? "#7b52b9" : "transparent"
                }}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom VRM Upload */}
        <div className={styles.fieldGroup}>
          <label className={styles.label} style={{ color: "#444838" }}>커스텀 .vrm 아바타</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".vrm"
            className="hidden"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <div className={styles.uploadRow}>
            <button
              onClick={() => fileInputRef.current?.click()}
              className={styles.uploadBtn}
              style={{ color: "#1c1f15", backgroundColor: "#fbf7ec" }}
            >
              <svg
                width="16"
                height="16"
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
                className={styles.resetBtn}
                style={{ color: "#dc2626" }}
                title="기본 아바타로 복원"
              >
                초기화
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Action Button */}
      <button onClick={onTakeSnapshot} className={styles.captureBtn} style={{ color: "#ffffff", backgroundColor: "#7b52b9" }}>
        <svg
          width="20"
          height="20"
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
        현재 아바타 포즈 캡처 및 리포트 생성
      </button>
    </div>
  );
}
