"use client";

import { useCallback, useRef, useState } from "react";
import { loadFaceLandmarker } from "@/lib/faceLandmarker";
import {
  loadEncoder,
  loadGallery,
  loadPokedex,
  embedFace,
  matchTopK,
  debugRank,
  POKEMATCH_IMG_SIZE,
  type PokematchMatch,
} from "@/lib/pokematch/matcher";

export type PokematchPhase = "idle" | "loading" | "aligning" | "scanning" | "analyzing" | "done" | "error";

const FRAMES_TO_AVERAGE = 8; // averaging several frames stabilizes the match (consistency)
const CROP_COEF = 1.15; // tight face-only crop margin
const ALIGN_TIMEOUT_MS = 15_000;

interface FaceBox {
  x: number;
  y: number;
  side: number;
}

/** Square face crop box (pixels) from MediaPipe normalized landmarks. */
function squareCrop(
  landmarks: { x: number; y: number }[],
  vw: number,
  vh: number
): FaceBox | null {
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
  source: HTMLVideoElement | HTMLImageElement,
  box: FaceBox,
  vw: number,
  vh: number,
  size: number
) {
  const sx = Math.max(0, box.x);
  const sy = Math.max(0, box.y);
  const sSide = Math.min(box.side, vw - sx, vh - sy);

  // 1. Fill base canvas with neutral studio gray (#808080)
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, size, size);

  // 2. Save context & create smooth oval face clipping path
  ctx.save();
  ctx.beginPath();
  const cx = size / 2;
  const cy = size / 2;
  const rx = (size / 2) * 0.92;
  const ry = (size / 2) * 0.96;
  ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
  ctx.clip();

  // 3. Draw face crop inside oval clip
  ctx.drawImage(source, sx, sy, sSide, sSide, 0, 0, size, size);
  ctx.restore();
}

export function usePokematchScan() {
  const [phase, setPhase] = useState<PokematchPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [matches, setMatches] = useState<PokematchMatch[] | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [debugText, setDebugText] = useState<string | null>(null);
  const runningRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const reset = useCallback(() => {
    runningRef.current = false;
    setPhase("idle");
    setProgress(0);
    setMatches(null);
    setErrorMessage("");
    setDebugText(null);
  }, []);

  const start = useCallback(async (video: HTMLVideoElement) => {
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
            if (lm) box = squareCrop(lm, vw, vh);
          } catch {
            /* transient detect error — keep trying */
          }

          if (!box) {
            if (performance.now() - startedAt > ALIGN_TIMEOUT_MS && embeddings.length === 0) {
              return reject(new Error("얼굴을 찾지 못했어요. 밝은 곳에서 정면을 봐주세요."));
            }
            return requestAnimationFrame(tick);
          }

          if (phase !== "scanning") setPhase("scanning");
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
      // Mean of the per-frame embeddings, renormalized.
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

      const top = matchTopK(mean, gallery, pokedex, 5);

      // Diagnostic readout (opt-in via ?debug): dumps the real face's full
      // ranking so a persistent single winner (hubness / miscalibration) can
      // be investigated against actual embeddings rather than proxies.
      if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug")) {
        const { byZ, byCos } = debugRank(mean, gallery, 20);
        const line = (r: (typeof byZ)[number]) =>
          `${r.slug.padEnd(14)} z=${r.z.toFixed(2).padStart(6)}  cos=${r.cos.toFixed(3)}  mu=${r.mu.toFixed(3)}  sd=${r.sd.toFixed(3)}`;
        // Full per-species cosine in gallery.species order (x1000, integer) —
        // collect this from several different people so the webcam-face mean
        // can be measured and the LFW-based mu recalibrated to the real query
        // distribution (the actual root cause of the shared winner).
        const dim = gallery.dim;
        const full = gallery.species.map((_, s) => {
          let dot = 0;
          const off = s * dim;
          for (let d = 0; d < dim; d++) dot += gallery.vecs[off + d] * mean[d];
          return Math.round(dot * 1000);
        });
        // Surface it on the page (a copyable textarea) rather than only the
        // console — MediaPipe's wasm logs flood devtools and bury it.
        setDebugText(
          "TOP20 by z-score:\n" +
            byZ.map(line).join("\n") +
            "\n\nTOP20 by raw cosine:\n" +
            byCos.map(line).join("\n") +
            "\n\nFULLCOS(species-order x1000):\n" +
            full.join(",")
        );
      }

      setMatches(top);
      setPhase("done");
      runningRef.current = false;
    } catch (err) {
      runningRef.current = false;
      setPhase("error");
      setErrorMessage((err as Error)?.message || "측정 중 오류가 발생했어요.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startWithImage = useCallback(async (image: HTMLImageElement) => {
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

      let box: FaceBox | null = null;
      try {
        const res = landmarker.detectForVideo
          ? landmarker.detectForVideo(image, performance.now())
          : landmarker.detect(image);
        const lm = res.faceLandmarks?.[0];
        if (lm) box = squareCrop(lm, iw, ih);
      } catch {
        try {
          const res = landmarker.detect(image);
          const lm = res.faceLandmarks?.[0];
          if (lm) box = squareCrop(lm, iw, ih);
        } catch (e) {
          console.warn("Face detection error on image:", e);
        }
      }

      if (!box) {
        throw new Error("사진에서 얼굴을 찾지 못했어요. 정면이 잘 보이는 얼굴 사진을 선택해 주세요.");
      }

      setPhase("scanning");
      setProgress(0.5);

      drawMaskedFaceCrop(ctx, image, box, iw, ih, POKEMATCH_IMG_SIZE);

      const embedding = await embedFace(session, canvas);
      setProgress(1);

      setPhase("analyzing");
      const top = matchTopK(embedding, gallery, pokedex, 5);

      if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug")) {
        const { byZ, byCos } = debugRank(embedding, gallery, 20);
        const line = (r: (typeof byZ)[number]) =>
          `${r.slug.padEnd(14)} z=${r.z.toFixed(2).padStart(6)}  cos=${r.cos.toFixed(3)}  mu=${r.mu.toFixed(3)}  sd=${r.sd.toFixed(3)}`;
        const dim = gallery.dim;
        const full = gallery.species.map((_, s) => {
          let dot = 0;
          const off = s * dim;
          for (let d = 0; d < dim; d++) dot += gallery.vecs[off + d] * embedding[d];
          return Math.round(dot * 1000);
        });
        setDebugText(
          "TOP20 by z-score:\n" +
            byZ.map(line).join("\n") +
            "\n\nTOP20 by raw cosine:\n" +
            byCos.map(line).join("\n") +
            "\n\nFULLCOS(species-order x1000):\n" +
            full.join(",")
        );
      }

      setMatches(top);
      setPhase("done");
      runningRef.current = false;
    } catch (err) {
      runningRef.current = false;
      setPhase("error");
      setErrorMessage((err as Error)?.message || "사진 분석 중 오류가 발생했어요.");
    }
  }, []);

  return { phase, progress, matches, errorMessage, debugText, start, startWithImage, reset };
}
