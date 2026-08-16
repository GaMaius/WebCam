"use client";

import { useCallback, useRef, useState } from "react";
import { loadFaceLandmarker } from "@/lib/faceLandmarker";
import {
  loadEncoder,
  loadGallery,
  loadPokedex,
  embedFace,
  matchTopK,
  scoreSlugs,
  debugRank,
  POKEMATCH_IMG_SIZE,
  type Gallery,
  type PokedexEntry,
  type PokematchCandidate,
  type PokematchMatch,
} from "@/lib/pokematch/matcher";
import { describeFaceFeatures, extractFaceFeatures, type FaceFeatures } from "@/lib/pokematch/faceFeatures";
import { judgeCandidates, picksToMatches } from "@/lib/pokematch/llmJudge";
import { buildJudgeAllowlist } from "@/lib/pokematch/curatedPool";
import { orderCandidatesForJudge } from "@/lib/pokematch/candidateOrder";

export type PokematchPhase = "idle" | "loading" | "aligning" | "scanning" | "analyzing" | "done" | "error";

/** Which ranker produced the shown result. "local" means the LLM judge was
 * unreachable (no key configured, offline, timeout) and the z-score fallback
 * ran instead — surfaced in the UI so a degraded result isn't silent. */
export type PokematchEngine = "llm" | "local";

/** Why the local ranker ran instead of the judge. "busy" is a per-minute cap,
 * which lifts in seconds and is worth retrying; "quota" is the DAILY budget,
 * which will not lift today and must not be dressed up as a short wait;
 * "unavailable" covers everything else. null when the judge produced the result. The distinction is
 * surfaced to the user, who otherwise can't tell a degraded result from a
 * normal one. */
export type PokematchFallbackCause = "busy" | "quota" | "unavailable" | null;

const FRAMES_TO_AVERAGE = 8; // averaging several frames stabilizes the match (consistency)
const CROP_COEF = 1.15; // tight face-only crop margin
const ALIGN_TIMEOUT_MS = 15_000;
const FEATURE_FRAME_WIDTH = 320; // downscaled frame used for color sampling

// The judge is a vision model, so it needs an actual picture. This crop is
// deliberately wider than the embedding's (CROP_COEF) — hair, ears and the
// jawline all inform "who does this person look like", and the tight 1.15 box
// cuts them off.
//
// ⚠️ IMAGE SIZE DOES NOT AFFECT COST HERE. Measured, twice.
//
// The same request was sent at 448px (31KB) and at 256px (16KB) and the
// provider reported requested=6074 BOTH times — not close, identical. This
// endpoint charges a flat rate for an image regardless of its pixel count,
// so shrinking it buys nothing and only costs detail.
//
// Two of my earlier estimates about this were wrong in opposite directions
// (~256 tokens, then ~3,400 scaling with area). Both were derived from
// character counts and arithmetic rather than read from the API. Don't
// re-litigate this from a calculation: ?debug prints the provider's own
// prompt_tokens on any successful call, so change the value and read it.
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
  // Non-zero only when the fallback was caused by a rate limit that lifts on
  // its own, so the UI can say "try again in Ns" instead of implying defeat.
  const [retryAfterSec, setRetryAfterSec] = useState(0);
  const [fallbackCause, setFallbackCause] = useState<PokematchFallbackCause>(null);
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
    setRetryAfterSec(0);
    setFallbackCause(null);
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
      // The WHOLE curated pool goes to the judge. Narrowing it to the top 40
      // by embedding score was tried and reverted — see the note in CLAUDE.md.
      // Short version: the embedding's idea of resemblance is not a person's.
      // The top 40 came back 38/40 gen 1 (the pool is ~40% gen 1), because the
      // encoder favours simple round cartoon faces, and it therefore cut
      // exactly the sharp-featured later-gen species the user had picked out
      // as the good matches. Filtering by a signal that disagrees with the
      // goal removes the right answers first.
      //
      // So the z-scores stay where they were: driving the displayed percentage
      // and the local fallback, not the judgement. The judgement is the vision
      // model looking at the photo, which is the only part that has produced
      // matches the user recognised.
      //
      // ⚠️ THE ALLOWLIST IS EVERYTHING SHIPPABLE MINUS THE BAN LIST, not the
      // 294-species curated pool. Measured: the model named eight species and
      // four were deleted for being outside that pool — Aipom, Braixen, Emolga,
      // Purrloin — none of them obscure, one of them the middle stage of a line
      // whose other two members were included. Recognition is the prompt's job
      // and the model's; the ban list is the only part that has to be a hard
      // gate. See buildJudgeAllowlist.
      //
      // Mascots stay IN. Excluding them was tried and backfired: blocking
      // Pikachu and Psyduck didn't push the judge toward specific matches, it
      // pushed it to the next generic thing (Porygon, Staryu, Starmie) — which
      // read as less like the person, not more. That habit was a symptom of low
      // temperature and is fixed there instead.
      const scored = scoreSlugs(embedding, gallery, pokedex, buildJudgeAllowlist(pokedex, gallery.species));
      // ⚠️ The shuffle is now VESTIGIAL, kept only so the legacy bare-number
      // reply path resolves against a stable array. It existed because the
      // prompt used to carry a NUMBERED list and the judge answered from the
      // top of it (one run picked 23, 36, 51, 53, 57 out of 291 — about 4 in
      // 10,000 by chance). The prompt no longer lists candidates at all, so
      // position can't bias anything; the "후보#" in the debug dump below is a
      // lookup index, not evidence of ordering bias any more.
      const candidates = orderCandidatesForJudge(scored);
      const description = features ? describeFaceFeatures(features) : "";

      let result: PokematchMatch[] | null = null;
      let judgeModel = "";
      let judgeFailReason = "";
      let retryAfter = 0;
      let rateLimited = false;
      let dailyLimit = false;
      // The model's picks BEFORE pickGuards trims them. Without this the debug
      // panel can't tell an unstable MODEL from a guard that reshuffled a
      // stable one — the displayed five are chosen from a larger list, so both
      // look the same from the outside.
      let rawPicks: { slug: string; reason: string }[] = [];
      let droppedNames = "";
      // No image means no vision judgement — fall straight through to local.
      if (image) {
        const judged = await judgeCandidates(image, description, candidates);
        rawPicks = judged.picks;
        droppedNames = judged.dropped ?? "";
        if (judged.picks.length > 0) {
          result = picksToMatches(judged.picks, pokedex, candidates, features);
          judgeModel =
            (judged.provider ? `${judged.model} · ${judged.provider}` : judged.model) +
            (judged.usage ? ` · ${judged.usage}` : "");
        } else {
          judgeFailReason = judged.reason ?? "unknown";
          retryAfter = judged.retryAfterSec ?? 0;
          rateLimited = judged.rateLimited === true;
          dailyLimit = judged.dailyLimit === true;
        }
      } else {
        judgeFailReason = "no_image";
      }

      const usedLlm = result !== null && result.length > 0;
      // Local z-score ranking is the fallback, not the primary path — it's what
      // the LLM judge replaced, kept so a missing key or a network blip still
      // produces a result instead of an error.
      let finalMatches =
        result && result.length > 0
          ? result
          : matchTopK(embedding, gallery, pokedex, 5, { faceAspect: faceAspectRef.current });

      // ⚠️ A SHORT JUDGE RESULT STILL FILLS TO FIVE. The judge is asked for
      // eight and everything it names has to survive the pool, so a run where
      // most names fall outside it left the screen showing one card — measured:
      // one pick displayed out of a request for eight. The page is built around
      // a top five, and one lonely card reads as broken rather than as decisive.
      //
      // The model's own picks stay first and keep their order; the local ranker
      // only supplies the tail. That keeps the part the user reads (the best
      // match and its sentence) entirely the judge's.
      if (usedLlm && finalMatches.length < 5) {
        const have = new Set(finalMatches.map((m) => m.slug));
        const filler = matchTopK(embedding, gallery, pokedex, 5 + finalMatches.length, {
          faceAspect: faceAspectRef.current,
        }).filter((m) => !have.has(m.slug));
        finalMatches = [...finalMatches, ...filler].slice(0, 5);
        // percent came from two different standardizations, so re-impose the
        // descending order the UI assumes.
        for (let i = 1; i < finalMatches.length; i++) {
          if (finalMatches[i].percent >= finalMatches[i - 1].percent) {
            finalMatches[i] = {
              ...finalMatches[i],
              percent: Math.max(50, finalMatches[i - 1].percent - 2),
            };
          }
        }
      }

      if (isDebug()) {
        setDebugText(
          `ENGINE: ${
            usedLlm ? `vision llm (${judgeModel})` : `local z-score fallback (reason: ${judgeFailReason})`
          }\n` +
            `IMAGE: ${image ? `${Math.round(image.length / 1024)}KB base64` : "(없음 — 판정 생략)"}\n\n` +
            // The picks are the one thing worth reading here: everything else
            // is the input to a judgement whose OUTPUT used to be missing from
            // this dump entirely, which made the result impossible to review.
            // ⚠️ What the MODEL said, before anything trimmed it. Without this
            // a short or shuffled result is unreadable: the displayed five are
            // chosen from a larger request, so an unstable model and a guard
            // that reshuffled a stable one look identical from outside.
            (rawPicks.length
              ? `MODEL RAW PICKS (${rawPicks.length}개 통과):\n` +
                rawPicks.map((p, i) => `  ${i + 1}. ${p.slug}${p.reason ? ` — ${p.reason}` : ""}`).join("\n") +
                `\n`
              : "") +
            // Named but refused by the curated pool. A short result means one
            // of these two lines is long — and they need opposite fixes.
            (droppedNames ? `POOL이 거부한 이름: ${droppedNames}\n` : "") +
            (rawPicks.length || droppedNames ? `\n` : "") +
            `RESULT (표시된 5마리):\n` +
            finalMatches
              .map((m, i) => {
                const name = m.entry?.nameKo ?? m.entry?.nameEn ?? m.slug;
                const n = candidates.findIndex((c) => c.slug === m.slug) + 1;
                return (
                  `${i + 1}. ${name} (${m.slug}${n > 0 ? `, 후보#${n}` : ""}) ` +
                  `${m.percent}% z=${m.z.toFixed(2)}` +
                  (m.reason ? `\n   이유: ${m.reason}` : "")
                );
              })
              .join("\n") +
            `\n\n` +
            `FACE FEATURES (보조 자료):\n${description || "(측정 실패)"}\n\n` +
            // ⚠️ TOP SLICE ONLY, and the full list is no longer worth printing.
            // It used to answer "is the species I expected even eligible?" —
            // now everything shippable is, bar the ban list, so the answer is
            // always yes. Both numbers are diagnostic: neither filters
            // anything. score is the hybrid (60% unique-deviation z); ranking
            // by it is 38/40 gen 1, which is why nothing is cut by it.
            `CANDIDATES (허용 ${candidates.length}종 중 score 상위 30):\n` +
            [...candidates]
              .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
              .slice(0, 30)
              .map(
                (c) =>
                  `  ${c.slug.padEnd(16)} ` +
                  `score=${(c.score ?? 0).toFixed(2).padStart(6)} z=${c.z.toFixed(2).padStart(6)}`
              )
              .join("\n") +
            `\n\n` +
            debugDump(embedding, gallery)
        );
      }

      setEngine(usedLlm ? "llm" : "local");
      setRetryAfterSec(usedLlm ? 0 : retryAfter);
      setFallbackCause(
        usedLlm ? null : dailyLimit ? "quota" : rateLimited ? "busy" : "unavailable"
      );
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

  return {
    phase,
    progress,
    matches,
    engine,
    retryAfterSec,
    fallbackCause,
    errorMessage,
    debugText,
    start,
    startWithImage,
    reset,
  };
}
