// Records the raw camera stream in the background (for data collection)
// while the on-screen analysis reads frames from the same stream via
// <video>/<canvas>. Recording never blocks or interferes with analysis,
// and any failure here is logged and swallowed — it must never break the
// user-facing measurement flow.

const CANDIDATE_MIME_TYPES = [
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

function pickSupportedMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

export interface BackgroundRecording {
  /** Stop recording and upload what's left. Always resolves. */
  finish: () => Promise<void>;
}

// Cut a complete, self-contained segment on this cadence and upload it while
// the page is still alive. Uploading only at unmount is unreliable for longer
// sessions (HeartPulse/PersonalFrame) — the in-flight upload gets cancelled as
// the page navigates away; short sessions (PokéMatch) happened to slip through.
// Rotating segments means the bulk of every recording is already uploaded
// before the user leaves, and only a small final segment rides on unmount.
const SEGMENT_MS = 10_000;

export function startBackgroundRecording(
  stream: MediaStream,
  label: string
): BackgroundRecording {
  const mimeType = pickSupportedMimeType();
  if (!mimeType) {
    return { finish: async () => {} };
  }

  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let stopped = false;
  let rotateTimer: ReturnType<typeof setInterval> | null = null;
  const uploads: Promise<void>[] = [];

  const beginSegment = () => {
    chunks = [];
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch (err) {
      console.error("could not start background recorder:", err);
      recorder = null;
      return;
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    try {
      recorder.start();
    } catch (err) {
      console.error("could not start background recorder:", err);
      recorder = null;
    }
  };

  // Stop the active segment, wait for it to flush, and queue its upload. Safe
  // to call repeatedly — a no-op once the recorder is already inactive.
  const cutSegment = async () => {
    const active = recorder;
    if (!active || active.state === "inactive") return;
    const localChunks = chunks;
    const flushed = new Promise<void>((resolve) => {
      active.addEventListener("stop", () => resolve(), { once: true });
      active.addEventListener("error", () => resolve(), { once: true });
    });
    active.stop();
    await flushed;
    if (localChunks.length > 0) {
      const blob = new Blob(localChunks, { type: mimeType });
      uploads.push(
        uploadRecording(blob, label, mimeType).catch((err) => {
          console.error("background recording upload failed:", err);
        })
      );
    }
  };

  beginSegment();
  if (recorder) {
    rotateTimer = setInterval(() => {
      void (async () => {
        await cutSegment();
        if (!stopped) beginSegment();
      })();
    }, SEGMENT_MS);
  }

  return {
    finish: async () => {
      if (stopped) return;
      stopped = true;
      if (rotateTimer) {
        clearInterval(rotateTimer);
        rotateTimer = null;
      }
      await cutSegment();
      await Promise.allSettled(uploads);
    },
  };
}

async function uploadRecording(blob: Blob, label: string, mimeType: string) {
  const contentType = mimeType.split(";")[0].trim();

  const presignRes = await fetch("/api/recordings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ module: label, contentType }),
  });
  if (!presignRes.ok) {
    throw new Error(`presign request failed: ${presignRes.status}`);
  }
  const { uploadUrl } = (await presignRes.json()) as { uploadUrl: string };

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });
  if (!putRes.ok) {
    throw new Error(`upload failed: ${putRes.status}`);
  }
}
