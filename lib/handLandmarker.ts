import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// Same CDN/pinning strategy as faceLandmarker.ts and poseLandmarker.ts.
const TASKS_VISION_VERSION = "0.10.35";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
// Only one hand model ships (no lite/full/heavy split), ~7MB.
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let handPromise: Promise<HandLandmarker> | null = null;

async function createHandLandmarker(delegate: "GPU" | "CPU"): Promise<HandLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate,
    },
    runningMode: "VIDEO",
    numHands: 2,
  });
}

/** Loads (and caches) the hand landmark model, falling back to the CPU delegate. */
export function loadHandLandmarker(): Promise<HandLandmarker> {
  if (!handPromise) {
    handPromise = createHandLandmarker("GPU").catch(async (err) => {
      console.warn("GPU hand landmarker failed, retrying on CPU:", err);
      return createHandLandmarker("CPU");
    });
    handPromise.catch(() => {
      handPromise = null;
    });
  }
  return handPromise;
}

export type { HandLandmarker } from "@mediapipe/tasks-vision";
