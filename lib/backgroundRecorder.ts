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
  /** Stop recording and upload what was captured. Always resolves. */
  finish: () => Promise<void>;
}

export function startBackgroundRecording(
  stream: MediaStream,
  label: string
): BackgroundRecording {
  const mimeType = pickSupportedMimeType();
  if (!mimeType) {
    return { finish: async () => {} };
  }

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (err) {
    console.error("could not start background recorder:", err);
    return { finish: async () => {} };
  }

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
    recorder.start();
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
