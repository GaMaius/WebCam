// Renders a single app's result into a shareable 1080x1350 PNG card (drawn to
// a canvas), so each standalone app can let the user save/share its own result
// image. One renderer per app; they share the shell, palette, and helpers.

import type { HeartPulseResult, PersonalFrameResult } from "./types";
import { typeColor } from "./typeColors";
import { pokemonImageUrl } from "./pokematch/assets";

export interface PersonalFrameLabels {
  season: Record<string, string>;
  undertone: Record<string, string>;
  faceShape: Record<string, string>;
  ita: Record<string, string>;
}

const W = 1080;
const H = 1350;
const PAD = 64;

const SANS = "'Segoe UI', system-ui, 'Noto Sans KR', sans-serif";
const MONO = "'SFMono-Regular', ui-monospace, 'JetBrains Mono', monospace";

const COL = {
  bg1: "#f5efe0",
  bg2: "#fbf7ec",
  surface: "#fffdf7",
  surfaceBorder: "rgba(28,31,21,0.5)",
  base: "#fbf7ec",
  baseBorder: "rgba(28,31,21,0.16)",
  text: "#1c1f15",
  textDim: "#565a48",
  textMuted: "#8b8a73",
};

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStat(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  label: string,
  value: string,
  opts: { unit?: string; monoValue?: boolean } = {}
) {
  const h = 130;
  roundRect(ctx, x, y, w, h, 16);
  ctx.fillStyle = COL.base;
  ctx.fill();
  ctx.strokeStyle = COL.baseBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = COL.textMuted;
  ctx.font = `600 20px ${SANS}`;
  ctx.fillText(label, x + 22, y + 40);

  const monoValue = opts.monoValue ?? true;
  ctx.fillStyle = COL.text;
  ctx.font = `700 ${monoValue ? 38 : 30}px ${monoValue ? MONO : SANS}`;
  ctx.fillText(value, x + 22, y + 92);

  if (opts.unit) {
    const valueWidth = ctx.measureText(value).width;
    ctx.fillStyle = COL.textDim;
    ctx.font = `500 18px ${SANS}`;
    ctx.fillText(opts.unit, x + 22 + valueWidth + 10, y + 92);
  }
}

/** Draws the shared card shell (background, accent glow, VisionLab eyebrow,
 * app title, date) and returns the Y offset where the body should start. */
function drawShell(
  ctx: CanvasRenderingContext2D,
  opts: { appName: string; accent: string; measuredAt?: string }
): number {
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, COL.bg1);
  bg.addColorStop(1, COL.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.85, 20, 40, W * 0.85, 20, 760);
  glow.addColorStop(0, hexToRgba(opts.accent, 0.14));
  glow.addColorStop(1, hexToRgba(opts.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  let y = 96;
  ctx.fillStyle = opts.accent;
  ctx.font = `700 26px ${SANS}`;
  ctx.fillText("VISIONLAB AI", PAD, y);

  y += 58;
  ctx.fillStyle = COL.text;
  ctx.font = `700 52px ${SANS}`;
  ctx.fillText(opts.appName, PAD, y);

  y += 40;
  const dateLabel = opts.measuredAt
    ? new Date(opts.measuredAt).toLocaleDateString("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";
  ctx.fillStyle = COL.textDim;
  ctx.font = `400 22px ${SANS}`;
  ctx.fillText(dateLabel, PAD, y);

  return y + 56;
}

function drawFooter(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = COL.textMuted;
  ctx.font = `500 18px ${SANS}`;
  ctx.textAlign = "center";
  ctx.fillText("모든 분석은 기기 내(온디바이스)에서 실시간으로 계산됩니다", W / 2, H - 48);
  ctx.textAlign = "left";
}

export function drawHeartPulseCard(
  canvas: HTMLCanvasElement,
  result: HeartPulseResult,
  accent = "#c4553a"
): void {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let y = drawShell(ctx, { appName: "HeartPulse", accent, measuredAt: result.measuredAt });

  const cardX = PAD;
  const cardW = W - PAD * 2;
  const cardY = y;
  const cardH = 720;

  roundRect(ctx, cardX, cardY, cardW, cardH, 28);
  ctx.fillStyle = COL.surface;
  ctx.fill();
  ctx.strokeStyle = COL.surfaceBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  const innerX = cardX + 40;
  let iy = cardY + 64;
  ctx.fillStyle = accent;
  ctx.font = `700 22px ${SANS}`;
  ctx.fillText("심박수", innerX, iy);

  iy += 96;
  const bpmText = `${result.bpm}`;
  ctx.fillStyle = COL.text;
  ctx.font = `700 132px ${MONO}`;
  ctx.fillText(bpmText, innerX, iy);
  const bpmWidth = ctx.measureText(bpmText).width;
  ctx.fillStyle = COL.textDim;
  ctx.font = `600 34px ${SANS}`;
  ctx.fillText("BPM", innerX + bpmWidth + 20, iy);

  const statsY = cardY + 300;
  const gap = 24;
  const statW = (cardW - 40 * 2 - gap) / 2;
  drawStat(
    ctx,
    innerX,
    statsY,
    statW,
    "스트레스 지수",
    result.stressIndex !== null ? `${result.stressIndex}` : "측정 불가",
    { unit: result.stressIndex !== null ? "/100" : undefined, monoValue: result.stressIndex !== null }
  );
  drawStat(ctx, innerX + statW + gap, statsY, statW, "측정 신뢰도", `${result.confidence}`, {
    unit: "%",
  });
  drawStat(
    ctx,
    innerX,
    statsY + 130 + gap,
    statW,
    "SDNN",
    result.sdnn !== null ? `${result.sdnn}` : "측정 불가",
    { unit: result.sdnn !== null ? "ms" : undefined, monoValue: result.sdnn !== null }
  );
  drawStat(
    ctx,
    innerX + statW + gap,
    statsY + 130 + gap,
    statW,
    "RMSSD",
    result.rmssd !== null ? `${result.rmssd}` : "측정 불가",
    { unit: result.rmssd !== null ? "ms" : undefined, monoValue: result.rmssd !== null }
  );

  drawFooter(ctx);
}

export function drawPersonalFrameCard(
  canvas: HTMLCanvasElement,
  result: PersonalFrameResult,
  labels: PersonalFrameLabels
): void {
  const accent = "#4b6b3a";
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let y = drawShell(ctx, { appName: "PersonalFrame", accent, measuredAt: result.measuredAt });

  const cardX = PAD;
  const cardW = W - PAD * 2;
  const cardY = y;
  const cardH = result.ambientCorrected ? 720 : 760;

  roundRect(ctx, cardX, cardY, cardW, cardH, 28);
  ctx.fillStyle = COL.surface;
  ctx.fill();
  ctx.strokeStyle = COL.surfaceBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  const innerX = cardX + 40;
  const iy = cardY + 60;
  ctx.fillStyle = COL.textMuted;
  ctx.font = `600 18px ${SANS}`;
  ctx.textAlign = "right";
  ctx.fillText(`측정 신뢰도 ${result.confidence}%`, cardX + cardW - 40, iy);
  ctx.textAlign = "left";

  const swatchSize = 96;
  const swatchX = innerX;
  const swatchY = iy - 4;
  roundRect(ctx, swatchX, swatchY, swatchSize, swatchSize, 20);
  ctx.fillStyle = result.skinHex;
  ctx.fill();
  ctx.strokeStyle = COL.surfaceBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = COL.text;
  ctx.font = `700 34px ${MONO}`;
  ctx.fillText(result.skinHex.toUpperCase(), swatchX + swatchSize + 28, swatchY + 40);
  ctx.fillStyle = COL.textDim;
  ctx.font = `500 22px ${MONO}`;
  ctx.fillText(
    `L ${result.lab.L}  a ${result.lab.a}  b ${result.lab.b}`,
    swatchX + swatchSize + 28,
    swatchY + 76
  );

  const statsY = swatchY + swatchSize + 44;
  const gap = 24;
  const statW = (cardW - 40 * 2 - gap) / 2;
  drawStat(ctx, innerX, statsY, statW, "언더톤", labels.undertone[result.undertone] ?? result.undertone, {
    monoValue: false,
  });
  drawStat(
    ctx,
    innerX + statW + gap,
    statsY,
    statW,
    "시즌 톤",
    labels.season[result.season] ?? result.season,
    { monoValue: false }
  );
  drawStat(
    ctx,
    innerX,
    statsY + 130 + gap,
    statW,
    "얼굴형",
    labels.faceShape[result.faceShape] ?? result.faceShape,
    { monoValue: false }
  );
  drawStat(ctx, innerX + statW + gap, statsY + 130 + gap, statW, "ITA° · 톤 깊이", `${result.ita}°`, {
    unit: labels.ita[result.itaCategory] ?? result.itaCategory,
  });

  if (!result.ambientCorrected) {
    ctx.fillStyle = COL.textMuted;
    ctx.font = `500 17px ${SANS}`;
    ctx.fillText("후면 카메라 조명 보정 없이 진행된 결과입니다", innerX, statsY + 130 + gap + 130 + 32);
  }

  drawFooter(ctx);
}

// --- PokéMatch card ---------------------------------------------------------
// Minimal shape of a match (decoupled from lib/pokematch/matcher so this file
// stays free of the onnxruntime dependency).
interface PokematchCardMatch {
  slug: string;
  percent: number;
  entry: {
    nameKo: string | null;
    nameEn: string;
    dex: number | null;
    typesKo: string[];
  } | null;
}

const POKEMATCH_ACCENT = "#d64541";

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // allow canvas export when images are on B2 (needs CORS)
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function drawPokematchCard(
  canvas: HTMLCanvasElement,
  matches: PokematchCardMatch[]
): Promise<void> {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  drawShell(ctx, { appName: "PokéMatch", accent: POKEMATCH_ACCENT });

  const imgs = await Promise.all(matches.map((m) => loadImage(pokemonImageUrl(m.slug))));

  const cardX = PAD;
  const cardW = W - PAD * 2;
  const rowH = 204; // row stride
  const boxH = rowH - 20; // card height (leaves a gap between rows)
  let y = 224;
  matches.slice(0, 5).forEach((m, idx) => {
    const e = m.entry;
    const rowY = y;
    roundRect(ctx, cardX, rowY, cardW, boxH, 24);
    ctx.fillStyle = idx === 0 ? COL.surface : COL.base;
    ctx.fill();
    ctx.strokeStyle = idx === 0 ? COL.surfaceBorder : COL.baseBorder;
    ctx.lineWidth = 2;
    ctx.stroke();

    const pad = 24;
    const thumb = boxH - pad * 2;
    const img = imgs[idx];
    if (img) {
      ctx.save();
      roundRect(ctx, cardX + pad, rowY + pad, thumb, thumb, 16);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.clip();
      const s = Math.min(thumb / img.width, thumb / img.height);
      const iw = img.width * s;
      const ih = img.height * s;
      ctx.drawImage(img, cardX + pad + (thumb - iw) / 2, rowY + pad + (thumb - ih) / 2, iw, ih);
      ctx.restore();
    }

    const tx = cardX + pad + thumb + 30;
    const nameKo = e?.nameKo ?? e?.nameEn ?? m.slug;
    const dex = e?.dex ? `#${e.dex} ` : "";
    ctx.fillStyle = COL.text;
    ctx.font = `800 38px ${SANS}`;
    ctx.fillText(`${dex}${nameKo}`, tx, rowY + 60);

    ctx.fillStyle = COL.textDim;
    ctx.font = `600 25px ${SANS}`;
    ctx.fillText(`닮은 정도 ${m.percent}%`, tx, rowY + 98);

    // Type badges — kept well inside the box (bottom ≈ rowY+150 vs box ${boxH}).
    const badgeTop = rowY + 116;
    const badgeH = 34;
    let bx = tx;
    for (const t of e?.typesKo ?? []) {
      ctx.font = `700 21px ${SANS}`;
      const w = ctx.measureText(t).width + 26;
      roundRect(ctx, bx, badgeTop, w, badgeH, 17);
      const c = typeColor(t);
      ctx.fillStyle = c.bg;
      ctx.fill();
      ctx.fillStyle = c.fg;
      ctx.fillText(t, bx + 13, badgeTop + 23);
      bx += w + 10;
    }

    y += rowH;
  });

  drawFooter(ctx);
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}
