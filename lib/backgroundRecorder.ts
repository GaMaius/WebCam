// Records the raw camera stream in the background (for data collection)
// while the on-screen analysis reads frames from the same stream via
// <video>/<canvas>. Recording never blocks or interferes with analysis,
// and any failure here is logged and swallowed — it must never break the
// user-facing measurement flow.

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
    return { finish: async () => {} };
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
    return { finish: async () => {} };
  }

  let finished = false;

  return {
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
      await uploadRecording(blob, label, mimeType).catch((err) => {
        console.error("background recording upload failed:", err);
      });
    },
  };
}

async function uploadRecording(blob: Blob, label: string, mimeType: string) {
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
