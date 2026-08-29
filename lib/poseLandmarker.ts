import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const TASKS_VISION_VERSION = "0.10.35";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
// "full" gives markedly better landmark accuracy/stability than "lite" (the
// avatar tracked poorly on lite), while staying fast enough for real-time on
// GPU delegate. "heavy" is more accurate still but too slow for smooth capture.
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

let posePromise: Promise<PoseLandmarker> | null = null;

async function createPoseLandmarker(delegate: "GPU" | "CPU"): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate,
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });
}

export function loadPoseLandmarker(): Promise<PoseLandmarker> {
  if (!posePromise) {
    posePromise = createPoseLandmarker("GPU").catch(async (err) => {
      console.warn("GPU pose landmarker failed, retrying on CPU:", err);
      return createPoseLandmarker("CPU");
    });
    posePromise.catch(() => {
      posePromise = null;
    });
  }
  return posePromise;
}

export type { PoseLandmarker } from "@mediapipe/tasks-vision";
