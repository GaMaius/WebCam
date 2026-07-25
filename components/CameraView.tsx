"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FacingMode } from "@/lib/types";
import {
  startBackgroundRecording,
  type BackgroundRecording,
} from "@/lib/backgroundRecorder";
import styles from "./CameraView.module.css";

type Status = "idle" | "requesting" | "ready" | "error";

export interface CameraHandle {
  video: HTMLVideoElement;
  stream: MediaStream;
  facingMode: FacingMode;
}

/** Turns an app label / route into a safe B2 key prefix ([a-z0-9-], max 40).
 * When no explicit label is given, the current route's first segment is used,
 * so any app that mounts <CameraView> is recorded and labeled automatically. */
function deriveRecordLabel(explicit?: string): string {
  const raw =
    explicit ??
    (typeof window !== "undefined"
      ? window.location.pathname.replace(/^\/+/, "").split("/")[0]
      : "");
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
  return cleaned || "app";
}

export function CameraView({
  initialFacing = "user",
  mirrorFront = true,
  allowSwitch = true,
  autoStart = false,
  maxWidth = 720,
  guide = "none",
  guideHint,
  record = true,
  audio = true,
  recordLabel,
  onReady,
  onStopped,
  overlay,
}: {
  initialFacing?: FacingMode;
  mirrorFront?: boolean;
  allowSwitch?: boolean;
  autoStart?: boolean;
  maxWidth?: number;
  guide?: "none" | "face";
  guideHint?: string;
  /** Whether to record the raw stream in the background and upload it to
   * storage when the camera stops/switches. Defaults to true — every moment
   * the webcam is on is recorded unless a caller explicitly opts out with
   * record={false}. Recording never blocks or interferes with analysis. */
  record?: boolean;
  /** Capture the microphone too and include it in the recording. Defaults to
   * true. If the mic is denied/absent, capture falls back to video-only so the
   * camera still works. */
  audio?: boolean;
  /** B2 key prefix for the recording. Defaults to the current route segment
   * (see deriveRecordLabel), so new apps are labeled automatically. */
  recordLabel?: string;
  onReady?: (handle: CameraHandle) => void;
  onStopped?: () => void;
  overlay?: React.ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<BackgroundRecording | null>(null);
  const [facing, setFacing] = useState<FacingMode>(initialFacing);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>("");
  const [hasMultiple, setHasMultiple] = useState(false);

  const finalizeRecorder = useCallback(() => {
    if (recorderRef.current) {
      const recording = recorderRef.current;
      recorderRef.current = null;
      void recording.finish();
    }
  }, []);

  const stop = useCallback(() => {
    finalizeRecorder();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus("idle");
    onStopped?.();
  }, [finalizeRecorder, onStopped]);

  const start = useCallback(
    async (mode: FacingMode) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setStatus("error");
        setError("이 브라우저는 카메라 접근을 지원하지 않습니다.");
        return;
      }
      setStatus("requesting");
      setError("");
      // Release any previous stream before requesting a new facing mode —
      // finalize its recording first, since stopping tracks first would
      // cut the recorder off mid-stream.
      finalizeRecorder();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      try {
        const videoConstraints = { facingMode: mode, width: { ideal: maxWidth } };
        let stream: MediaStream;
        try {
          // Record audio too (default). One combined camera+mic permission prompt.
          stream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio,
          });
        } catch (audioErr) {
          // If the mic is missing/denied, audio:true rejects the whole request —
          // fall back to video-only so the camera still works (no audio recorded).
          if (audio) {
            stream = await navigator.mediaDevices.getUserMedia({
              video: videoConstraints,
              audio: false,
            });
          } else {
            throw audioErr;
          }
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => {});
        setStatus("ready");

        if (record) {
          recorderRef.current = startBackgroundRecording(stream, deriveRecordLabel(recordLabel));
        }

        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          setHasMultiple(devices.filter((d) => d.kind === "videoinput").length > 1);
        } catch {
          /* enumerateDevices is best-effort */
        }

        onReady?.({ video, stream, facingMode: mode });
      } catch (err) {
        const e = err as DOMException;
        setStatus("error");
        if (e.name === "NotAllowedError" || e.name === "SecurityError") {
          setError("카메라 권한이 거부되었습니다. 브라우저 주소창의 권한 설정에서 허용해 주세요.");
        } else if (e.name === "NotFoundError" || e.name === "OverconstrainedError") {
          setError("사용 가능한 카메라를 찾지 못했습니다.");
        } else if (!window.isSecureContext) {
          setError("카메라는 HTTPS(또는 localhost) 환경에서만 동작합니다.");
        } else {
          setError(`카메라를 시작할 수 없습니다: ${e.message || e.name}`);
        }
      }
    },
    [maxWidth, onReady, record, audio, recordLabel, finalizeRecorder]
  );

  const switchCamera = useCallback(() => {
    const next: FacingMode = facing === "user" ? "environment" : "user";
    setFacing(next);
    void start(next);
  }, [facing, start]);

  useEffect(() => {
    if (autoStart) void start(initialFacing);
    return () => {
      // Component unmount (e.g. navigating away mid-scan): finalize any
      // in-progress recording before the stream's tracks are torn down.
      finalizeRecorder();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mirrored = mirrorFront && facing === "user";

  return (
    <div className={styles.stage}>
      <video
        ref={videoRef}
        className={styles.video}
        style={{ transform: mirrored ? "scaleX(-1)" : "none" }}
        playsInline
        muted
      />

      {guide === "face" && status === "ready" && (
        <div className={styles.guideWrap} aria-hidden>
          <div className={styles.faceGuide} />
          {guideHint && <div className={styles.guideHint}>{guideHint}</div>}
        </div>
      )}

      {overlay && status === "ready" && (
        <div className={styles.overlay}>{overlay}</div>
      )}

      {status !== "ready" && (
        <div className={styles.curtain}>
          {status === "idle" && (
            <button className={styles.primaryBtn} onClick={() => start(facing)}>
              <CamIcon /> 카메라 시작
            </button>
          )}
          {status === "requesting" && (
            <div className={styles.spinnerRow}>
              <span className={styles.spinner} /> 카메라 준비 중…
            </div>
          )}
          {status === "error" && (
            <div className={styles.errorBox}>
              <p>{error}</p>
              <button className={styles.ghostBtn} onClick={() => start(facing)}>
                다시 시도
              </button>
            </div>
          )}
        </div>
      )}

      {status === "ready" && (
        <div className={styles.controls}>
          <span className={styles.facingTag}>
            {facing === "user" ? "전면" : "후면"} 카메라
          </span>
          {allowSwitch && hasMultiple && (
            <button className={styles.iconBtn} onClick={switchCamera} title="카메라 전환">
              <SwitchIcon />
            </button>
          )}
          <button className={styles.iconBtn} onClick={stop} title="카메라 끄기">
            <StopIcon />
          </button>
        </div>
      )}
    </div>
  );
}

function CamIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
function SwitchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}
