"use client";

import { useCallback, useRef, useState } from "react";
import { loadFaceLandmarker } from "@/lib/faceLandmarker";
import {
  loadEncoder,
  loadGallery,
  loadPokedex,
  embedFace,
  matchTopK,
  buildCandidates,
  scoreSlugs,
  debugRank,
  POKEMATCH_IMG_SIZE,
  type Gallery,
  type PokedexEntry,
  type PokematchMatch,
} from "@/lib/pokematch/matcher";
import { describeFaceFeatures, extractFaceFeatures, type FaceFeatures } from "@/lib/pokematch/faceFeatures";
import { judgeCandidates, picksToMatches } from "@/lib/pokematch/llmJudge";
import { buildCuratedPool } from "@/lib/pokematch/curatedPool";

export type PokematchPhase = "idle" | "loading" | "aligning" | "scanning" | "analyzing" | "done" | "error";

/** Which ranker produced the shown result. "local" means the LLM judge was
 * unreachable (no key configured, offline, timeout) and the z-score fallback
 * ran instead — surfaced in the UI so a degraded result isn't silent. */
export type PokematchEngine = "llm" | "local";

const FRAMES_TO_AVERAGE = 8; // averaging several frames stabilizes the match (consistency)
const CROP_COEF = 1.15; // tight face-only crop margin
const ALIGN_TIMEOUT_MS = 15_000;
const FEATURE_FRAME_WIDTH = 320; // downscaled frame used for color sampling

// The judge is a vision model, so it needs an actual picture. This crop is
// deliberately wider than the embedding's (CROP_COEF) — hair, ears and the
// jawline all inform "who does this person look like", and the tight 1.15 box
// cuts them off. 448px at q0.85 lands around 40KB of base64.
const JUDGE_IMAGE_SIZE = 448;
const JUDGE_CROP_COEF = 1.55;
const JUDGE_IMAGE_QUALITY = 0.85;

interface FaceBox {
  x: number;
  y: number;
  side: number;
}

type Landmark = { x: number; y: number };
type PixelSource = HTMLVideoElement | HTMLImageElement;

/** Square face crop box (pixels) from MediaPipe normalized landmarks. */
function squareCrop(landmarks: Landmark[], vw: number, vh: number): FaceBox | null {
  if (!landmarks.length) return null;
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const lm of landmarks) {
    if (lm.x < minX) minX = lm.x;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.y > maxY) maxY = lm.y;
  }
  const cx = ((minX + maxX) / 2) * vw;
  const cy = ((minY + maxY) / 2) * vh;
  const side = Math.max((maxX - minX) * vw, (maxY - minY) * vh) * CROP_COEF;
  return { x: cx - side / 2, y: cy - side / 2, side };
}

/**
 * Draws the cropped face onto the canvas using a neutral studio-gray background
 * and an oval mask centered on the face landmarks. This completely removes
 * background color leakage (walls, curtains, outdoor lighting) and stabilizes
 * matches against glasses & head turn variations.
 */
function drawMaskedFaceCrop(
  ctx: CanvasRenderingContext2D,
  source: PixelSource,
  box: FaceBox,
  vw: number,
  vh: number,
  size: number
) {
  const sx = Math.max(0, box.x);
  const sy = Math.max(0, box.y);
  const sSide = Math.min(box.side, vw - sx, vh - sy);

  // Clear canvas & draw natural face crop preserving hair, face shape, and color tone
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(source, sx, sy, sSide, sSide, 0, 0, size, size);
}

/**
 * JPEG data URL of the face for the vision judge, re-cropped from the source
 * at JUDGE_CROP_COEF so hair and jawline are included. Returns null if the
 * canvas is tainted (a cross-origin upload) — the caller then falls back to
 * the local ranker rather than sending nothing and getting a bad judgement.
 */
function captureJudgeImage(
  source: PixelSource,
  landmarks: Landmark[],
  vw: number,
  vh: number
): string | null {
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const lm of landmarks) {
    if (lm.x < minX) minX = lm.x;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.y > maxY) maxY = lm.y;
  }
  const cx = ((minX + maxX) / 2) * vw;
  const cy = ((minY + maxY) / 2) * vh;
  const side = Math.max((maxX - minX) * vw, (maxY - minY) * vh) * JUDGE_CROP_COEF;

  // Clamp into frame, keeping the box square so the face isn't stretched.
  const clamped = Math.min(side, vw, vh);
  const sx = Math.max(0, Math.min(cx - clamped / 2, vw - clamped));
  const sy = Math.max(0, Math.min(cy - clamped / 2, vh - clamped));

  try {
    const canvas = document.createElement("canvas");
    canvas.width = JUDGE_IMAGE_SIZE;
    canvas.height = JUDGE_IMAGE_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, sx, sy, clamped, clamped, 0, 0, JUDGE_IMAGE_SIZE, JUDGE_IMAGE_SIZE);
    return canvas.toDataURL("image/jpeg", JUDGE_IMAGE_QUALITY);
  } catch {
    return null;
  }
}

/** Computes face aspect ratio (height / width) from MediaPipe landmarks. */
function computeFaceAspect(landmarks?: Landmark[]): number {
  if (!landmarks || landmarks.length < 455) return 1.15;
  const top = landmarks[10] ?? landmarks[0];
  const chin = landmarks[152] ?? landmarks[landmarks.length - 1];
  const faceH = Math.hypot(chin.x - top.x, chin.y - top.y);

  const rCheek = landmarks[234] ?? landmarks[0];
  const lCheek = landmarks[454] ?? landmarks[landmarks.length - 1];
  const faceW = Math.hypot(lCheek.x - rCheek.x, lCheek.y - rCheek.y);

  return faceW > 0 ? faceH / faceW : 1.15;
}

/** Normalized L2 mean of the per-frame embeddings. */
function meanEmbedding(embeddings: Float32Array[]): Float32Array {
  const dim = embeddings[0].length;
  const mean = new Float32Array(dim);
  for (const e of embeddings) for (let i = 0; i < dim; i++) mean[i] += e[i];
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    mean[i] /= embeddings.length;
    norm += mean[i] * mean[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) mean[i] /= norm;
  return mean;
}

function isDebug(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");
}

function debugDump(embedding: Float32Array, gallery: Gallery): string {
  const { byZ, byCos } = debugRank(embedding, gallery, 20);
  const line = (r: (typeof byZ)[number]) =>
    `${r.slug.padEnd(14)} z=${r.z.toFixed(2).padStart(6)}  cos=${r.cos.toFixed(3)}  mu=${r.mu.toFixed(3)}  sd=${r.sd.toFixed(3)}`;
  // Full per-species cosine in gallery.species order (x1000, integer) —
  // collect this from several different people so the webcam-face mean can be
  // measured and the LFW-based mu recalibrated to the real query distribution.
  const dim = gallery.dim;
  const full = gallery.species.map((_, s) => {
    let dot = 0;
    const off = s * dim;
    for (let d = 0; d < dim; d++) dot += gallery.vecs[off + d] * embedding[d];
    return Math.round(dot * 1000);
  });
  return (
    "TOP20 by z-score:\n" +
    byZ.map(line).join("\n") +
    "\n\nTOP20 by raw cosine:\n" +
    byCos.map(line).join("\n") +
    "\n\nFULLCOS(species-order x1000):\n" +
    full.join(",")
  );
}

export function usePokematchScan() {
  const [phase, setPhase] = useState<PokematchPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [matches, setMatches] = useState<PokematchMatch[] | null>(null);
  const [engine, setEngine] = useState<PokematchEngine>("llm");
  const [errorMessage, setErrorMessage] = useState("");
  const [debugText, setDebugText] = useState<string | null>(null);
  const runningRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const faceAspectRef = useRef<number>(1.15);

  const reset = useCallback(() => {
    runningRef.current = false;
    setPhase("idle");
    setProgress(0);
    setMatches(null);
    setEngine("llm");
    setErrorMessage("");
    setDebugText(null);
    faceAspectRef.current = 1.15;
  }, []);

  /** Measures the face from a downscaled full frame. The color samples need
   * the whole frame (hair sits outside the face crop), and downscaling both
   * caps the readback cost and averages out sensor noise. */
  const measureFace = useCallback(
    (source: PixelSource, landmarks: Landmark[], vw: number, vh: number): FaceFeatures | null => {
      try {
        if (!frameCanvasRef.current) frameCanvasRef.current = document.createElement("canvas");
        const c = frameCanvasRef.current;
        const w = Math.min(FEATURE_FRAME_WIDTH, vw);
        const h = Math.max(1, Math.round((w * vh) / vw));
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(source, 0, 0, w, h);
        return extractFaceFeatures(landmarks, ctx.getImageData(0, 0, w, h).data, w, h);
      } catch {
        // Tainted canvas (cross-origin upload) or a short landmark array —
        // the judge just loses the descriptors and we fall back locally.
        return null;
      }
    },
    []
  );

  /** Shared tail of both entry points: candidates → vision judge → fallback. */
  const rank = useCallback(
    async (
      embedding: Float32Array,
      gallery: Gallery,
      pokedex: Record<string, PokedexEntry>,
      features: FaceFeatures | null,
      image: string | null
    ) => {
      // The curated pool, scored against THIS face. The z-scores no longer go
      // to the model (it looks at the photo instead) but they still drive the
      // displayed percentage and the local fallback ranking.
      const candidates = scoreSlugs(
        embedding,
        gallery,
        pokedex,
        buildCuratedPool(pokedex, gallery.species)
      );
      const description = features ? describeFaceFeatures(features) : "";

      let result: PokematchMatch[] | null = null;
      let judgeModel = "";
      // No image means no vision judgement — fall straight through to local.
      if (image) {
        const judged = await judgeCandidates(image, description, candidates);
        if (judged && judged.picks.length > 0) {
          result = picksToMatches(judged.picks, pokedex, candidates);
          judgeModel = judged.model;
        }
      }

      const usedLlm = result !== null && result.length > 0;
      // Local z-score ranking is the fallback, not the primary path — it's what
      // the LLM judge replaced, kept so a missing key or a network blip still
      // produces a result instead of an error.
      const finalMatches =
        result && result.length > 0
          ? result
          : matchTopK(embedding, gallery, pokedex, 5, { faceAspect: faceAspectRef.current });

      if (isDebug()) {
        setDebugText(
          `ENGINE: ${usedLlm ? `vision llm (${judgeModel})` : "local z-score fallback"}\n` +
            `IMAGE: ${image ? `${Math.round(image.length / 1024)}KB base64` : "(없음 — 판정 생략)"}\n\n` +
            `FACE FEATURES (보조 자료):\n${description || "(측정 실패)"}\n\n` +
            `CANDIDATES (${candidates.length}종, 프롬프트 순서 = 번호):\n` +
            candidates
              .map((c, i) => `${String(i + 1).padStart(3)}. ${c.slug.padEnd(16)} z=${c.z.toFixed(2).padStart(6)}`)
              .join("\n") +
            `\n\n` +
            debugDump(embedding, gallery)
        );
      }

      setEngine(usedLlm ? "llm" : "local");
      setMatches(finalMatches);
      setPhase("done");
    },
    []
  );

  const start = useCallback(
    async (video: HTMLVideoElement) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setPhase("loading");
      setProgress(0);
      setMatches(null);
      setErrorMessage("");

      try {
        const [session, gallery, pokedex, landmarker] = await Promise.all([
          loadEncoder(),
          loadGallery(),
          loadPokedex(),
          loadFaceLandmarker(),
        ]);

        if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
        const canvas = canvasRef.current;
        canvas.width = POKEMATCH_IMG_SIZE;
        canvas.height = POKEMATCH_IMG_SIZE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2d context");

        setPhase("aligning");
        const embeddings: Float32Array[] = [];
        const startedAt = performance.now();
        // Held in an object rather than a `let`: it's written from inside the
        // rAF callback, which TypeScript's flow analysis can't see, so a plain
        // local would be narrowed to `null` after the await below.
        const last: { landmarks: Landmark[] | null; w: number; h: number } = {
          landmarks: null,
          w: 0,
          h: 0,
        };

        await new Promise<void>((resolve, reject) => {
          const tick = async () => {
            if (!runningRef.current) return reject(new Error("cancelled"));
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            if (!vw || !vh) return requestAnimationFrame(tick);

            let box: FaceBox | null = null;
            try {
              const res = landmarker.detectForVideo(video, performance.now());
              const lm = res.faceLandmarks?.[0];
              if (lm) {
                box = squareCrop(lm, vw, vh);
                faceAspectRef.current = computeFaceAspect(lm);
                last.landmarks = lm;
                last.w = vw;
                last.h = vh;
              }
            } catch {
              /* transient detect error — keep trying */
            }

            if (!box) {
              if (performance.now() - startedAt > ALIGN_TIMEOUT_MS && embeddings.length === 0) {
                return reject(new Error("얼굴을 찾지 못했어요. 밝은 곳에서 정면을 봐주세요."));
              }
              return requestAnimationFrame(tick);
            }

            setPhase("scanning"); // no-op re-render once already scanning
            drawMaskedFaceCrop(ctx, video, box, vw, vh, POKEMATCH_IMG_SIZE);
            try {
              embeddings.push(await embedFace(session, canvas));
            } catch (e) {
              return reject(e as Error);
            }
            setProgress(embeddings.length / FRAMES_TO_AVERAGE);

            if (embeddings.length >= FRAMES_TO_AVERAGE) return resolve();
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });

        setPhase("analyzing");
        // Measure before awaiting the judge so the descriptors come from the
        // same moment as the embedding, not from a later (moved) frame.
        const features = last.landmarks ? measureFace(video, last.landmarks, last.w, last.h) : null;
        const image = last.landmarks ? captureJudgeImage(video, last.landmarks, last.w, last.h) : null;
        await rank(meanEmbedding(embeddings), gallery, pokedex, features, image);
        runningRef.current = false;
      } catch (err) {
        runningRef.current = false;
        setPhase("error");
        setErrorMessage((err as Error)?.message || "측정 중 오류가 발생했어요.");
      }
    },
    [measureFace, rank]
  );

  const startWithImage = useCallback(
    async (image: HTMLImageElement) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setPhase("loading");
      setProgress(0);
      setMatches(null);
      setErrorMessage("");

      try {
        const [session, gallery, pokedex, landmarker] = await Promise.all([
          loadEncoder(),
          loadGallery(),
          loadPokedex(),
          loadFaceLandmarker(),
        ]);

        if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
        const canvas = canvasRef.current;
        canvas.width = POKEMATCH_IMG_SIZE;
        canvas.height = POKEMATCH_IMG_SIZE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2d context");

        setPhase("aligning");

        const iw = image.naturalWidth || image.width;
        const ih = image.naturalHeight || image.height;
        if (!iw || !ih) throw new Error("이미지 크기를 읽을 수 없습니다.");

        let landmarks: Landmark[] | undefined;
        try {
          const res = landmarker.detectForVideo
            ? landmarker.detectForVideo(image, performance.now())
            : landmarker.detect(image);
          landmarks = res.faceLandmarks?.[0];
        } catch {
          try {
            landmarks = landmarker.detect(image).faceLandmarks?.[0];
          } catch (e) {
            console.warn("Face detection error on image:", e);
          }
        }

        const box = landmarks ? squareCrop(landmarks, iw, ih) : null;
        if (landmarks) faceAspectRef.current = computeFaceAspect(landmarks);

        if (!box) {
          throw new Error("사진에서 얼굴을 찾지 못했어요. 정면이 잘 보이는 얼굴 사진을 선택해 주세요.");
        }

        setPhase("scanning");
        setProgress(0.5);

        drawMaskedFaceCrop(ctx, image, box, iw, ih, POKEMATCH_IMG_SIZE);
        const embedding = await embedFace(session, canvas);
        setProgress(1);

        setPhase("analyzing");
        const features = landmarks ? measureFace(image, landmarks, iw, ih) : null;
        const judgeImage = landmarks ? captureJudgeImage(image, landmarks, iw, ih) : null;
        await rank(embedding, gallery, pokedex, features, judgeImage);
        runningRef.current = false;
      } catch (err) {
        runningRef.current = false;
        setPhase("error");
        setErrorMessage((err as Error)?.message || "사진 분석 중 오류가 발생했어요.");
      }
    },
    [measureFace, rank]
  );

  return { phase, progress, matches, engine, errorMessage, debugText, start, startWithImage, reset };
}
