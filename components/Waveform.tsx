"use client";

import { useEffect, useRef } from "react";
import styles from "./Waveform.module.css";

export function Waveform({ values, color = "#f78ca0" }: { values: number[]; color?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    if (values.length < 2) return;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    values.forEach((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const normalized = (v - min) / range; // 0-1
      const y = height - normalized * height * 0.82 - height * 0.09;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [values, color]);

  return (
    <div className={styles.wrap}>
      <canvas ref={canvasRef} width={600} height={120} className={styles.canvas} />
    </div>
  );
}
