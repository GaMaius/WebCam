"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { canvasToPngBlob } from "@/lib/resultCard";
import styles from "./ResultActions.module.css";

/**
 * Reusable "이미지로 저장 / 공유하기" actions for any app's result screen.
 * The caller supplies a `render` that draws the app's result into a canvas and
 * returns it; this component handles PNG export, download, and the Web Share
 * API (with a download fallback where share is unavailable).
 */
export function ResultActions({
  render,
  filename,
  shareTitle,
  shareText,
  hint = "이 결과를 이미지로 저장하거나 공유할 수 있어요.",
}: {
  render: () => HTMLCanvasElement;
  filename: string;
  shareTitle: string;
  shareText: string;
  hint?: string;
}) {
  const [canShare, setCanShare] = useState(false);
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const renderRef = useRef(render);
  renderRef.current = render;

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  const makeBlob = useCallback(async () => {
    const canvas = renderRef.current();
    return canvasToPngBlob(canvas);
  }, []);

  const handleSave = useCallback(async () => {
    setState("working");
    try {
      const blob = await makeBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch (err) {
      console.error("result image export failed:", err);
      setState("error");
    }
  }, [makeBlob, filename]);

  const handleShare = useCallback(async () => {
    setState("working");
    try {
      const blob = await makeBlob();
      const file = new File([blob], filename, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: shareTitle, text: shareText });
        setState("idle");
      } else {
        await handleSave();
      }
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") {
        setState("idle");
        return;
      }
      console.error("result image share failed:", err);
      setState("error");
    }
  }, [makeBlob, filename, shareTitle, shareText, handleSave]);

  return (
    <div className={styles.wrap}>
      <p className={styles.hint}>{hint}</p>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={handleSave} disabled={state === "working"}>
          이미지로 저장
        </button>
        {canShare && (
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleShare}
            disabled={state === "working"}
          >
            공유하기
          </button>
        )}
      </div>
      {state === "error" && (
        <p className={styles.error}>이미지 생성에 실패했습니다. 다시 시도해주세요.</p>
      )}
    </div>
  );
}
