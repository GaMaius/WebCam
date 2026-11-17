"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FacingMode } from "@/lib/types";
import {
  drainPendingUploads,
  startBackgroundRecording,
  type BackgroundRecording,
} from "@/lib/backgroundRecorder";
import styles from "./CameraView.module.css";

type Status = "idle" | "requesting" | "ready" | "error";

/** Below this the backgrounded mic clip is container headers and nothing else
 * (what iOS produces, since it suspends audio capture on background). Opus
 * carries even quiet speech at a few KB/s, so real audio clears this easily. */
const AUDIO_ONLY_MIN_BYTES = 4096;

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
  maxHeight,
  guide = "none",
  guideHint,
  record = true,
  audio = true,
  recordLabel,
  flushKey = 0,
  autoFlushIntervalMs = 20000,
  showControls = true,
  onReady,
  onStopped,
  overlay,
}: {
  initialFacing?: FacingMode;
  mirrorFront?: boolean;
  allowSwitch?: boolean;
  autoStart?: boolean;
  maxWidth?: number;
  /** Optional ideal capture height. Left unset the camera picks its own aspect
   * ratio (usually 16:9). Setting it asks for a specific frame shape — 4:3 gives
   * a hand near the top or bottom of the frame more pixels to be found in, which
   * is what the trackers care about. */
  maxHeight?: number;
  guide?: "none" | "face";
  guideHint?: string;
  /** Show the on-stage control bar (facing tag / switch / stop). Set false for
   * a compact embedded self-view (e.g. a picture-in-picture) where recording is
   * managed by the page lifecycle rather than a manual stop button. */
  showControls?: boolean;
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
  /** Bump this (e.g. on scan completion or snapshot) to finalize + upload the current
   * recording as ONE file while the page is still active — reliable, unlike an
   * unmount-time upload on iOS Safari — then a fresh recording starts to keep capturing. */
  flushKey?: number;
  /** Automatically flush & upload recording clips periodically (default: 20 seconds).
   * Essential for continuous apps like VRMMotion so iOS Safari devices reliably upload
   * video clips before pagehide/unmount cancels in-flight fetches. Set to 0 to disable. */
  autoFlushIntervalMs?: number;
  onReady?: (handle: CameraHandle) => void;
  onStopped?: () => void;
  overlay?: React.ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<BackgroundRecording | null>(null);
  const audioRecorderRef = useRef<BackgroundRecording | null>(null);
  const [facing, setFacing] = useState<FacingMode>(initialFacing);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>("");
  const [hasMultiple, setHasMultiple] = useState(false);

  const finalizeRecorder = useCallback((): Promise<void> => {
    const recording = recorderRef.current;
    recorderRef.current = null;
    return recording ? recording.finish() : Promise.resolve();
  }, []);

  const finalizeAudioOnly = useCallback((): Promise<void> => {
    const recording = audioRecorderRef.current;
    audioRecorderRef.current = null;
    return recording ? recording.finish() : Promise.resolve();
  }, []);

  /**
   * Mic-only recording for while the app is in the background.
   *
   * Video capture is stopped by the OS the moment the page is backgrounded and
   * nothing can change that, but audio is a separate pipeline:
   *   - iOS Safari suspends WebRTC/Web Audio on background or screen lock, so
   *     this captures nothing there. It costs nothing either — the clip comes
   *     out under AUDIO_ONLY_MIN_BYTES and is discarded rather than uploaded.
   *   - Android Chrome often keeps the mic alive, though a throttled tab can
   *     still drop stretches.
   * So this is opportunistic by design: take whatever the platform allows,
   * never depend on it. Uploads land as audio/webm → `.weba` in the same
   * prefix, which is also how you tell on a real device whether it worked.
   */
  const beginAudioOnlyRecording = useCallback(() => {
    if (!record || !audio || audioRecorderRef.current) return;
    const stream = streamRef.current;
    if (!stream) return;
    const liveAudio = stream.getAudioTracks().filter((t) => t.readyState === "live");
    if (liveAudio.length === 0) return;
    audioRecorderRef.current = startBackgroundRecording(
      new MediaStream(liveAudio),
      deriveRecordLabel(recordLabel),
      { audioOnly: true, minBytes: AUDIO_ONLY_MIN_BYTES }
    );
  }, [record, audio, recordLabel]);

  const beginRecording = useCallback(() => {
    if (!record || !streamRef.current) return;
    // A recorder that has stopped (the OS killed it while backgrounded) is
    // replaced, not treated as still running — see BackgroundRecording.isActive.
    if (recorderRef.current?.isActive()) return;
    // Starting while hidden produces an empty clip on mobile: the page is
    // suspended and no frames arrive. Wait until we're visible again.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    // Nothing to flush if it already stopped, but finish() is idempotent and
    // uploads whatever it managed to capture before it died.
    const stale = recorderRef.current;
    if (stale) void stale.finish();
    recorderRef.current = startBackgroundRecording(streamRef.current, deriveRecordLabel(recordLabel));
  }, [record, recordLabel]);

  const stop = useCallback(async () => {
    // Flush + upload the recording before tearing the tracks down.
    await finalizeRecorder();
    await finalizeAudioOnly();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus("idle");
    onStopped?.();
  }, [finalizeRecorder, finalizeAudioOnly, onStopped]);

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
      // finalize its recording first (awaited), since stopping the tracks
      // would otherwise cut the recorder off before its final segment
      // flushes and uploads.
      await finalizeRecorder();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      try {
        const videoConstraints: MediaTrackConstraints = {
          facingMode: mode,
          width: { ideal: maxWidth },
          ...(maxHeight ? { height: { ideal: maxHeight } } : {}),
        };
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

        beginRecording();

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
    [maxWidth, maxHeight, onReady, audio, finalizeRecorder, beginRecording]
  );

  const switchCamera = useCallback(() => {
    const next: FacingMode = facing === "user" ? "environment" : "user";
    setFacing(next);
    void start(next);
  }, [facing, start]);

  // On scan completion or snapshot, caller bumps flushKey: finalize + upload the current
  // recording as one file now while page is active (reliable, especially on iOS Safari).
  const flushKeyRef = useRef(flushKey);
  useEffect(() => {
    if (flushKey === flushKeyRef.current) return;
    flushKeyRef.current = flushKey;
    void (async () => {
      await finalizeRecorder();
      beginRecording();
    })();
  }, [flushKey, finalizeRecorder, beginRecording]);

  // Periodic Auto-Flush: Automatically flushes and uploads recording every N seconds (default: 20s)
  // so continuous apps like VRMMotion reliably upload video clips while the page is active,
  // preventing iOS Safari from cancelling unmount-time uploads.
  useEffect(() => {
    if (!autoFlushIntervalMs || autoFlushIntervalMs <= 0 || status !== "ready") return;

    const timer = setInterval(() => {
      // Timers still fire (throttled) while hidden on some browsers. Rotating
      // then would close a clip and open one that captures nothing.
      if (document.visibilityState === "hidden") return;
      void (async () => {
        await finalizeRecorder();
        beginRecording();
      })();
    }, autoFlushIntervalMs);

    return () => clearInterval(timer);
  }, [autoFlushIntervalMs, status, finalizeRecorder, beginRecording]);

  const statusRef = useRef<Status>(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // The lifecycle effect below runs once, so it reads the live `start` and
  // facing through refs rather than capturing the versions from first render.
  const startRef = useRef(start);
  startRef.current = start;
  const facingRef = useRef(facing);
  facingRef.current = facing;
  const resumingRef = useRef(false);

  useEffect(() => {
    if (autoStart) void start(initialFacing);
    // Anything an earlier session couldn't finish uploading (killed mid-PUT by
    // an app switch) is retried now.
    void drainPendingUploads().catch(() => {});

    /** Leaving: on mobile this is the last moment our code runs. Close the clip
     * and get it into the durable queue — the 20s rotation can't help here
     * because timers are frozen the instant the page is backgrounded, so up to
     * a full interval of footage used to be lost. */
    const handleHidden = () => {
      void finalizeRecorder().then(() => {
        // Video is gone until we're foregrounded again, but the mic may not be.
        // Opportunistic — see beginAudioOnlyRecording.
        if (document.visibilityState === "hidden") beginAudioOnlyRecording();
      });
    };

    /** Returning. The camera does NOT keep capturing in the background — that's
     * an OS restriction with no web workaround — so the job here is to restart
     * cleanly and lose nothing. */
    const handleVisibleOrFocus = () => {
      if (document.visibilityState !== "visible" || resumingRef.current) return;

      // Close the mic-only clip first: it and the full A/V recorder share the
      // audio track, and leaving both running would record it twice.
      void finalizeAudioOnly();

      const stream = streamRef.current;
      // iOS ends the camera track outright when the app is backgrounded. An
      // ended track can't be revived: the preview is a frozen frame and any
      // new recorder captures nothing, so the stream has to be re-acquired.
      const cameraDead =
        !stream ||
        stream.getVideoTracks().length === 0 ||
        stream.getVideoTracks().some((t) => t.readyState === "ended");

      if (cameraDead && statusRef.current === "ready") {
        resumingRef.current = true;
        void startRef
          .current(facingRef.current)
          .finally(() => {
            resumingRef.current = false;
          });
        return;
      }

      if (stream) {
        stream.getTracks().forEach((t) => {
          if (!t.enabled) t.enabled = true;
        });
      }
      if (videoRef.current && statusRef.current === "ready") {
        videoRef.current.play().catch(() => {});
      }
      // Restarts a recorder that was closed on hide, or one the OS stopped
      // without telling us (isActive, not a null check — see backgroundRecorder).
      if (record && stream) beginRecording();
      void drainPendingUploads().catch(() => {});
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") handleHidden();
      else handleVisibleOrFocus();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleVisibleOrFocus);
    window.addEventListener("pagehide", handleHidden);
    window.addEventListener("beforeunload", handleHidden);
    // Chrome's Page Lifecycle: last callback before a backgrounded tab is
    // frozen and possibly discarded without further events.
    window.addEventListener("freeze", handleHidden);
    window.addEventListener("resume", handleVisibleOrFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibleOrFocus);
      window.removeEventListener("pagehide", handleHidden);
      window.removeEventListener("beforeunload", handleHidden);
      window.removeEventListener("freeze", handleHidden);
      window.removeEventListener("resume", handleVisibleOrFocus);

      // Component unmount: finalize any in-progress recording.
      void finalizeRecorder();
      void finalizeAudioOnly();
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

      {status === "ready" && showControls && (
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
