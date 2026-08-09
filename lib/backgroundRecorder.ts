import { drainPending, removePending, stashPending } from "./pendingUploads";

// Records the raw camera stream in the background (for data collection)
// while the on-screen analysis reads frames from the same stream via
// <video>/<canvas>. Recording never blocks or interferes with analysis,
// and any failure here is logged and swallowed — it must never break the
// user-facing measurement flow.

// ⚠️ WebM stays first ON PURPOSE. MP4 would be nicer to open later (QuickTime,
// Windows, phone galleries all play it; webm needs VLC or a browser), but it
// costs real storage — measured in Chromium on identical 4s 640x480 captures:
//
//   webm vp9   601 KB      mp4 avc1 baseline  1,270 KB
//   webm vp8   911 KB      mp4 avc1 main      1,224 KB
//   (current)              mp4 avc1 high      1,253 KB
//
// i.e. mp4 is ~+39% over the vp8 we ship today, and every H.264 profile lands
// in the same place because the encoder targets a codec-specific default
// bitrate rather than a quality level — raising the profile does not help.
// The user was shown these numbers on 2026-08-09 and chose to keep webm.
//
// (vp9 is ~34% SMALLER than vp8 at the same settings and is a live option, at
// the cost of heavier encoding on a phone that is already running MediaPipe.)
//
// iOS Safari cannot produce webm at all, so phones already upload mp4 — that
// is browser capability, not this list.
const CANDIDATE_MIME_TYPES_WITH_AUDIO = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=h264,opus",
  "video/mp4",
  "video/quicktime",
];

const CANDIDATE_MIME_TYPES_VIDEO_ONLY = [
  "video/webm;codecs=vp8",
  "video/webm;codecs=vp9",
  "video/webm",
  "video/mp4;codecs=avc1",
  "video/mp4;codecs=h264",
  "video/mp4",
  "video/quicktime",
];

function createMediaRecorder(
  stream: MediaStream
): { recorder: MediaRecorder; mimeType: string } | null {
  if (typeof MediaRecorder === "undefined") return null;

  const hasAudio = stream.getAudioTracks().length > 0;
  const candidateTypes = hasAudio
    ? CANDIDATE_MIME_TYPES_WITH_AUDIO
    : CANDIDATE_MIME_TYPES_VIDEO_ONLY;

  for (const type of candidateTypes) {
    if (MediaRecorder.isTypeSupported(type)) {
      try {
        const recorder = new MediaRecorder(stream, { mimeType: type });
        return { recorder, mimeType: type };
      } catch {
        // try next candidate
      }
    }
  }

  // Fallback 1: Try default constructor without explicit options
  try {
    const recorder = new MediaRecorder(stream);
    const fallbackMime = recorder.mimeType || (hasAudio ? "video/webm" : "video/webm");
    return { recorder, mimeType: fallbackMime };
  } catch (err) {
    console.error("could not create default MediaRecorder:", err);
  }

  // Fallback 2: Try video-only mime candidates as a last resort
  for (const type of CANDIDATE_MIME_TYPES_VIDEO_ONLY) {
    try {
      const recorder = new MediaRecorder(stream, { mimeType: type });
      return { recorder, mimeType: type };
    } catch {
      // ignore
    }
  }

  return null;
}

export interface BackgroundRecording {
  /** Stop recording and upload the whole clip as one file. Always resolves. */
  finish: () => Promise<void>;
  /** Whether the underlying MediaRecorder is still capturing.
   *
   * ⚠️ Needed because a recorder can die without anyone nulling our reference:
   * backgrounding a phone stops the MediaRecorder and ends the camera track,
   * but the objects stay. Checking "is the handle non-null" therefore reports
   * a corpse as healthy, which is exactly how recordings silently stopped
   * resuming after an app switch. */
  isActive: () => boolean;
}

// One continuous recording per call → one uploaded file. Reliability comes
// from *when* finish() is called: the caller (CameraView) finalizes at the
// moment a scan completes, while the page is still alive, rather than only on
// unmount (where a large in-flight upload gets cancelled during navigation).
export function startBackgroundRecording(
  stream: MediaStream,
  label: string
): BackgroundRecording {
  const instance = createMediaRecorder(stream);
  if (!instance) {
    return { finish: async () => {}, isActive: () => false };
  }

  const { recorder, mimeType } = instance;
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  const errored = new Promise<void>((resolve) => {
    recorder.addEventListener("error", () => resolve(), { once: true });
  });

  try {
    recorder.start(1000);
  } catch (err) {
    console.error("could not start background recorder:", err);
    return { finish: async () => {}, isActive: () => false };
  }

  let finished = false;

  return {
    isActive: () => !finished && recorder.state === "recording",
    finish: async () => {
      if (finished) return;
      finished = true;

      if (recorder.state !== "inactive") {
        try {
          recorder.requestData();
        } catch {
          /* ignore if requestData not ready */
        }
        recorder.stop();
        await Promise.race([stopped, errored]);
      }

      if (chunks.length === 0) return;
      const blob = new Blob(chunks, { type: mimeType });
      await persistAndUpload(blob, label, mimeType);
    },
  };
}

/**
 * Writes the clip to the durable queue, uploads it, then clears it.
 *
 * The order matters on mobile: finalizing usually happens exactly when the
 * user is leaving (app switch, navigation), and that is precisely when an
 * in-flight upload gets cancelled. Persisting first means the clip is
 * recoverable on the next visit instead of gone. See lib/pendingUploads.ts.
 */
export async function persistAndUpload(blob: Blob, label: string, mimeType: string) {
  const contentType = mimeType.split(";")[0].trim() || "video/webm";
  const pendingId = await stashPending(blob, label, contentType).catch(() => null);
  try {
    await uploadCapture(blob, label, contentType);
    if (pendingId !== null) await removePending(pendingId);
  } catch (err) {
    console.error("background recording upload failed (queued for retry):", err);
    // Nothing else to do — the clip is in the queue, drainPendingUploads()
    // picks it up when the page next comes back.
  }
}

/** Retries clips left behind by an interrupted session. Call on mount and
 * whenever the page becomes visible again. */
export function drainPendingUploads(): Promise<number> {
  return drainPending((blob, label, contentType) => uploadCapture(blob, label, contentType));
}

/**
 * Uploads one captured blob to B2 through a presigned PUT.
 *
 * Used for finished recordings and for stills the user uploads instead of
 * using the camera — both land under the same `<label>/<date>/<ip>/` prefix,
 * so a session's record is complete whichever way the capture happened.
 *
 * ⚠️ The PUT must NOT use `fetch keepalive` — keepalive requests are capped at
 * a 64KB body, which silently fails whole videos. (The small presign POST
 * below is fine.) See the note in CLAUDE.md.
 */
export async function uploadCapture(blob: Blob, label: string, mimeType: string) {
  const contentType = mimeType.split(";")[0].trim() || "video/webm";

  const presignRes = await fetch("/api/recordings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ module: label, contentType }),
    keepalive: true,
  });
  if (!presignRes.ok) {
    const errText = await presignRes.text().catch(() => "");
    throw new Error(`presign request failed: ${presignRes.status} ${errText}`);
  }
  const { uploadUrl } = (await presignRes.json()) as { uploadUrl: string };

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });
  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => "");
    throw new Error(`upload failed: ${putRes.status} ${errText}`);
  }
}
