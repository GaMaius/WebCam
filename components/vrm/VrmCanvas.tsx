"use client";

import React, { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { VRMSceneManager, BgStyle } from "@/lib/vrm/vrmScene";
import type { VRM } from "@pixiv/three-vrm";
import styles from "./VrmCanvas.module.css";

export interface VrmCanvasRef {
  loadVRM: (urlOrBuffer: string | ArrayBuffer) => Promise<VRM>;
  setBgStyle: (style: BgStyle) => void;
  getVRM: () => VRM | null;
  takeSnapshot: () => string;
}

interface VrmCanvasProps {
  bgStyle?: BgStyle;
  initialVrmUrl?: string;
  onVrmLoaded?: (vrm: VRM) => void;
}

export const VrmCanvas = forwardRef<VrmCanvasRef, VrmCanvasProps>(
  ({ bgStyle = "dark", initialVrmUrl = "/models/avatar.vrm", onVrmLoaded }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sceneManagerRef = useRef<VRMSceneManager | null>(null);

    useImperativeHandle(ref, () => ({
      loadVRM: async (urlOrBuffer) => {
        if (!sceneManagerRef.current) throw new Error("Scene not ready");
        const vrm = await sceneManagerRef.current.loadVRM(urlOrBuffer);
        return vrm;
      },
      setBgStyle: (style) => {
        sceneManagerRef.current?.setBgStyle(style);
      },
      getVRM: () => sceneManagerRef.current?.getVRM() ?? null,
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
      if (initialVrmUrl) {
        manager
          .loadVRM(initialVrmUrl)
          .then((vrm) => {
            if (onVrmLoaded) onVrmLoaded(vrm);
          })
          .catch((err) => {
            console.error("Failed to load initial VRM model:", err);
          });
      }

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
