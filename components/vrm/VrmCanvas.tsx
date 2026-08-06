"use client";

import React, { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { VRMSceneManager, BgStyle } from "@/lib/vrm/vrmScene";
import type { MotionAvatar } from "@/lib/vrm/motionAvatar";
import { DEFAULT_PRESET, type AvatarPreset } from "@/lib/vrm/avatarPresets";
import styles from "./VrmCanvas.module.css";

export interface VrmCanvasRef {
  /** `nameHint` carries the extension for uploaded buffers (.vrm/.fbx/.glb). */
  loadAvatar: (urlOrBuffer: string | ArrayBuffer, nameHint?: string) => Promise<MotionAvatar>;
  loadPreset: (preset: AvatarPreset) => Promise<MotionAvatar>;
  setBgStyle: (style: BgStyle) => void;
  setFraming: (framing: "full" | "upper") => void;
  getAvatar: () => MotionAvatar | null;
  takeSnapshot: () => string;
}

interface VrmCanvasProps {
  bgStyle?: BgStyle;
  initialPreset?: AvatarPreset;
  onVrmLoaded?: (avatar: MotionAvatar) => void;
}

export const VrmCanvas = forwardRef<VrmCanvasRef, VrmCanvasProps>(
  ({ bgStyle = "dark", initialPreset = DEFAULT_PRESET, onVrmLoaded }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sceneManagerRef = useRef<VRMSceneManager | null>(null);

    useImperativeHandle(ref, () => ({
      loadAvatar: async (urlOrBuffer, nameHint) => {
        if (!sceneManagerRef.current) throw new Error("Scene not ready");
        return sceneManagerRef.current.loadAvatar(urlOrBuffer, nameHint);
      },
      loadPreset: async (preset) => {
        if (!sceneManagerRef.current) throw new Error("Scene not ready");
        return sceneManagerRef.current.loadPreset(preset);
      },
      setBgStyle: (style) => {
        sceneManagerRef.current?.setBgStyle(style);
      },
      setFraming: (framing) => {
        sceneManagerRef.current?.setFraming(framing);
      },
      getAvatar: () => sceneManagerRef.current?.getAvatar() ?? null,
      takeSnapshot: () => sceneManagerRef.current?.takeSnapshot() ?? "",
    }));

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const manager = new VRMSceneManager(canvas);
      sceneManagerRef.current = manager;
      manager.setBgStyle(bgStyle);

      // Force initial size calculation
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        manager.resize(rect.width, rect.height);
      } else {
        manager.resize(400, 300);
      }

      // Resize observer
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            manager.resize(width, height);
          }
        }
      });
      if (canvas.parentElement) {
        resizeObserver.observe(canvas.parentElement);
      }

      // Load initial model
      manager
        .loadPreset(initialPreset)
        .then((avatar) => {
          if (onVrmLoaded) onVrmLoaded(avatar);
        })
        .catch((err) => {
          console.error("Failed to load initial avatar:", err);
        });

      return () => {
        resizeObserver.disconnect();
        manager.dispose();
        sceneManagerRef.current = null;
      };
    }, []);

    useEffect(() => {
      if (sceneManagerRef.current) {
        sceneManagerRef.current.setBgStyle(bgStyle);
      }
    }, [bgStyle]);

    return (
      <div className={styles.canvasWrap}>
        <canvas ref={canvasRef} className={styles.canvas} />
      </div>
    );
  }
);

VrmCanvas.displayName = "VrmCanvas";
