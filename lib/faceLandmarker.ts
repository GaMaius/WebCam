import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// MediaPipe's WASM runtime + model are fetched from Google's public CDN at
// runtime (client-side only) rather than bundled, keeping the app lightweight.
// Pinned to the same version as the npm package so the JS API and WASM binary
// stay in lockstep.
const TASKS_VISION_VERSION = "0.10.35";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

async function createLandmarker(delegate: "GPU" | "CPU"): Promise<FaceLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate,
    },
    runningMode: "VIDEO",
    numFaces: 1,
    // The 52 ARKit blendshapes come from a head on this same model, so enabling
    // them is far cheaper than a second model — and they drive VRM expressions
    // (brows and gaze included) much better than a geometric solve.
    // lib/vrm/faceExpressions.ts consumes them.
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  });
}

/** Loads (and caches) the face landmark model. Falls back to CPU delegate
 * if GPU/WebGL isn't available in the current browser/environment. */
export function loadFaceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = createLandmarker("GPU").catch(async (err) => {
      console.warn("GPU face landmarker failed, retrying on CPU:", err);
      return createLandmarker("CPU");
    });
    landmarkerPromise.catch(() => {
      // Allow a future call to retry from scratch if both delegates failed.
      landmarkerPromise = null;
    });
  }
  return landmarkerPromise;
}

export type { FaceLandmarker } from "@mediapipe/tasks-vision";
