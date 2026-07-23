// Face geometry (facial thirds, cheekbone/jaw/forehead width, jaw angle)
// and a rule-based face-shape classification, derived from MediaPipe Face
// Landmarker's 468-point mesh.
//
// Landmark indices below are NOT guessed from memory — they're taken from
// MediaPipe's own published FACEMESH_FACE_OVAL / FACEMESH_*_EYEBROW /
// FACEMESH_NOSE connection sets (mediapipe/python/solutions/
// face_mesh_connections.py), which is the same 468-point topology the
// Tasks API's FaceLandmarker uses. FACEMESH_FACE_OVAL traces the face
// silhouette as an ordered loop starting at 10 (top of forehead) through
// 152 (chin) and back — the width landmarks below (234/454 at cheekbone
// level, 172/397 at jaw level, 54/284 near the temple) are points along
// that same verified loop, picked at roughly symmetric positions on
// either side rather than asserted as precise named anatomical points
// (e.g. "gonion") — that's a deliberate simplification for a "fun"
// classifier, not a clinical claim.
const LM = {
  FOREHEAD_TOP: 10,
  CHIN: 152,
  CHEEK_RIGHT: 234,
  CHEEK_LEFT: 454,
  JAW_RIGHT: 172,
  JAW_LEFT: 397,
  TEMPLE_RIGHT: 54,
  TEMPLE_LEFT: 284,
  NOSE_BASE: 2,
} as const;

const EYEBROW_INDICES = [
  46, 53, 52, 65, 55, 70, 63, 105, 66, 107, // right eyebrow
  276, 283, 282, 295, 285, 300, 293, 334, 296, 336, // left eyebrow
];

export interface Point2D {
  x: number;
  y: number;
}

export type FaceLandmarkArray = Point2D[];

export interface FaceGeometry {
  thirds: [number, number, number];
  lengthToWidth: number;
  jawAngle: number;
}

export type FaceShape = "oval" | "round" | "square" | "heart" | "oblong" | "diamond";

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function angleBetween(v1: Point2D, v2: Point2D): number {
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 === 0 || mag2 === 0) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

export function computeFaceGeometry(landmarks: FaceLandmarkArray): FaceGeometry {
  const foreheadTop = landmarks[LM.FOREHEAD_TOP];
  const chin = landmarks[LM.CHIN];
  const cheekR = landmarks[LM.CHEEK_RIGHT];
  const cheekL = landmarks[LM.CHEEK_LEFT];
  const jawR = landmarks[LM.JAW_RIGHT];
  const jawL = landmarks[LM.JAW_LEFT];
  const noseBase = landmarks[LM.NOSE_BASE];

  const eyebrowY = mean(EYEBROW_INDICES.map((i) => landmarks[i].y));

  const faceLength = Math.abs(chin.y - foreheadTop.y);
  const cheekboneWidth = dist(cheekR, cheekL);

  const upper = Math.abs(eyebrowY - foreheadTop.y);
  const mid = Math.abs(noseBase.y - eyebrowY);
  const lower = Math.abs(chin.y - noseBase.y);
  const totalThirds = upper + mid + lower || 1;

  const jawAngle = angleBetween(
    { x: jawR.x - chin.x, y: jawR.y - chin.y },
    { x: jawL.x - chin.x, y: jawL.y - chin.y }
  );

  return {
    thirds: [(upper / totalThirds) * 3, (mid / totalThirds) * 3, (lower / totalThirds) * 3],
    lengthToWidth: cheekboneWidth === 0 ? 0 : faceLength / cheekboneWidth,
    jawAngle,
  };
}

/**
 * Rule-based face-shape classification. This is a simplified heuristic
 * (there's no single agreed-upon algorithm even among human stylists) —
 * intended as a fun, directionally-sensible result, not a precise or
 * clinical measurement.
 */
export function classifyFaceShape(landmarks: FaceLandmarkArray): FaceShape {
  const foreheadTop = landmarks[LM.FOREHEAD_TOP];
  const chin = landmarks[LM.CHIN];
  const cheekR = landmarks[LM.CHEEK_RIGHT];
  const cheekL = landmarks[LM.CHEEK_LEFT];
  const jawR = landmarks[LM.JAW_RIGHT];
  const jawL = landmarks[LM.JAW_LEFT];
  const templeR = landmarks[LM.TEMPLE_RIGHT];
  const templeL = landmarks[LM.TEMPLE_LEFT];

  const faceLength = Math.abs(chin.y - foreheadTop.y);
  const cheekboneWidth = dist(cheekR, cheekL) || 1e-6;
  const jawWidth = dist(jawR, jawL);
  const foreheadWidth = dist(templeR, templeL);

  const lengthToWidth = faceLength / cheekboneWidth;
  const jawToCheek = jawWidth / cheekboneWidth;
  const foreheadToCheek = foreheadWidth / cheekboneWidth;
  const jawAngle = angleBetween(
    { x: jawR.x - chin.x, y: jawR.y - chin.y },
    { x: jawL.x - chin.x, y: jawL.y - chin.y }
  );

  if (lengthToWidth > 1.55) return "oblong";
  if (jawToCheek > 0.9 && foreheadToCheek > 0.9 && jawAngle > 120) return "square";
  if (lengthToWidth < 1.15 && jawToCheek > 0.85) return "round";
  if (foreheadToCheek > 0.95 && jawToCheek < 0.75) return "heart";
  if (foreheadToCheek < 0.9 && jawToCheek < 0.85) return "diamond";
  return "oval";
}
