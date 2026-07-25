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
const CROP_COEF = 1.3; // square face crop margin — mirrors the Colab test crop
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

export function usePokematchScan() {
  const [phase, setPhase] = useState<PokematchPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [matches, setMatches] = useState<PokematchMatch[] | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const runningRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const reset = useCallback(() => {
    runningRef.current = false;
    setPhase("idle");
    setProgress(0);
    setMatches(null);
    setErrorMessage("");
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
          // Draw the (clamped) square crop, scaled to the encoder input.
          const sx = Math.max(0, box.x);
          const sy = Math.max(0, box.y);
          const sSide = Math.min(box.side, vw - sx, vh - sy);
          ctx.drawImage(video, sx, sy, sSide, sSide, 0, 0, POKEMATCH_IMG_SIZE, POKEMATCH_IMG_SIZE);
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
        // Plain-text (copy-pasteable) rows — console.table collapses to
        // "Array(20)" when pasted out of devtools, so print strings instead.
        const line = (r: (typeof byZ)[number]) =>
          `${r.slug.padEnd(14)} z=${r.z.toFixed(2).padStart(6)}  cos=${r.cos.toFixed(3)}  mu=${r.mu.toFixed(3)}  sd=${r.sd.toFixed(3)}`;
        // eslint-disable-next-line no-console
        console.log("[pokematch debug] top-20 by z-score (the ranking used):\n" + byZ.map(line).join("\n"));
        // eslint-disable-next-line no-console
        console.log("[pokematch debug] top-20 by raw cosine (pre-debias):\n" + byCos.map(line).join("\n"));

        // Full per-species cosine in gallery.species order (x1000, integer) —
        // paste this from several different people so the webcam-face mean can
        // be measured and the LFW-based mu recalibrated to the real query
        // distribution (the actual root cause of the shared winner).
        const dim = gallery.dim;
        const full = gallery.species.map((_, s) => {
          let dot = 0;
          const off = s * dim;
          for (let d = 0; d < dim; d++) dot += gallery.vecs[off + d] * mean[d];
          return Math.round(dot * 1000);
        });
        // eslint-disable-next-line no-console
        console.log("[pokematch debug] FULLCOS(species-order x1000):\n" + full.join(","));
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

  return { phase, progress, matches, errorMessage, start, reset };
}
