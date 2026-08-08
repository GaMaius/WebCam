"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModuleShell } from "@/components/ModuleShell";
import { CameraView, type CameraHandle } from "@/components/CameraView";
import styles from "./page.module.css";

const ACCENT = "#e8a13d";

/** Where the vendored app is served from (public/gesture-synth). */
const APP_URL = "/gesture-synth/index.html";

/** How long to wait for a stream before showing the camera panel so the user can
 * see the actual error and retry. Covers every failure mode at once — denied,
 * no device, unsupported browser — without CameraView needing a new callback. */
const CAMERA_TIMEOUT_MS = 8000;

/**
 * Gesture Synth — an embed, not a port.
 *
 * The instrument itself is Eric Wei's app, used with permission and vendored
 * byte-for-byte under public/gesture-synth. This page is the VisionLab shell
 * around it, and it exists to do one thing the embedded app can't do for itself:
 * own the camera.
 *
 * Every moment this site's webcam is on has to be recorded and uploaded, and
 * <CameraView> is the only component allowed to open a camera. So CameraView
 * takes the stream here and publishes it on `window.__visionlabStream`; a small
 * shim at the top of the vendored index.html waits for it and returns it from the
 * app's own getUserMedia call. One stream, one permission prompt, recording
 * intact, and the app's code untouched.
 */
export default function GestureSynthPage() {
  const [streamReady, setStreamReady] = useState(false);
  /**
   * One-way latch: the instrument is mounted only once a stream exists, and stays
   * mounted after that.
   *
   * Mounting it up front looked fine and wasn't. The frame's shim starts waiting
   * for the stream the moment it loads, and if the camera permission takes longer
   * than the shim's patience it falls back to its own getUserMedia — a second
   * permission prompt and a stream nothing records, the exact thing this page
   * exists to prevent. Mounting late removes the race instead of tuning it: the
   * shim's first poll already finds the stream. It never unmounts, so a stream
   * hiccup can't wipe the running instrument.
   */
  const [appMounted, setAppMounted] = useState(false);
  // The camera panel is hidden while things are working and revealed when they
  // aren't, so a failure still shows its own message and retry button.
  const [revealCamera, setRevealCamera] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);

  const publishStream = (stream: MediaStream | null) => {
    const w = window as unknown as { __visionlabStream?: MediaStream };
    if (stream) w.__visionlabStream = stream;
    else delete w.__visionlabStream;
  };

  const handleCameraReady = useCallback((handle: CameraHandle) => {
    streamRef.current = handle.stream;
    // The embedded app polls for this, so it can be set before or after its
    // getUserMedia call — no handshake to get wrong.
    publishStream(handle.stream);
    setStreamReady(true);
    setAppMounted(true);
    setRevealCamera(false);
  }, []);

  const handleCameraStopped = useCallback(() => {
    publishStream(null);
    setStreamReady(false);
  }, []);

  useEffect(() => {
    if (streamReady) return;
    const timer = setTimeout(() => setRevealCamera(true), CAMERA_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [streamReady]);

  // Don't leave a stale stream on the global for the next page to pick up.
  useEffect(() => () => publishStream(null), []);

  return (
    <ModuleShell eyebrow="제스처 · 신스" title="Gesture Synth" accent={ACCENT}>
      <div className={styles.stage}>
        {/* The instrument. It draws its own mirrored self-view with landmark dots,
            so this page shows no separate camera preview.

            No `allow="camera"` — the frame never opens a camera of its own. No
            `sandbox` either: it needs same-origin to read the stream off this
            window, and `allow-scripts allow-same-origin` together is not a real
            boundary anyway, while dropping `allow-popups` would break the external
            links in the app's own help dialog. This is code we vendored and read. */}
        {appMounted && <iframe className={styles.frame} src={APP_URL} title="Gesture Synth" />}
        {!appMounted && (
          <div className={styles.overlay}>
            {revealCamera ? (
              <>
                카메라를 시작할 수 없습니다.
                <br />
                아래 카메라 패널의 안내를 따라 권한을 허용하고 다시 시도해 주세요.
              </>
            ) : (
              <>
                <span className={styles.spinner} aria-hidden />
                카메라를 준비하고 있어요…
              </>
            )}
          </div>
        )}
      </div>

      {/* Owns the stream and the background recording. MediaRecorder reads the
          stream rather than this element, so keeping it out of sight costs
          nothing — but it must stay MOUNTED: unmounting tears the stream down
          under the instrument. */}
      <div
        className={revealCamera && !appMounted ? styles.cameraPanel : styles.cameraHidden}
        aria-hidden={!revealCamera || appMounted}
      >
        <CameraView
          autoStart
          initialFacing="user"
          allowSwitch={false}
          showControls={false}
          // Matches what the embedded app asks for, so the shim hands it exactly
          // the frame shape it was tuned against.
          maxWidth={640}
          maxHeight={480}
          recordLabel="gesturesynth"
          onReady={handleCameraReady}
          onStopped={handleCameraStopped}
        />
      </div>

      <p className={styles.credit}>
        악기 제작:{" "}
        <a href="https://indecisiveeric.com" target="_blank" rel="noopener noreferrer">
          Eric Wei
        </a>
        . 본인 허락을 받아 VisionLab에 그대로 실었습니다. 손 인식은 MediaPipe Hand
        Landmarker로 브라우저에서 처리됩니다.
      </p>
    </ModuleShell>
  );
}
