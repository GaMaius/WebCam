// Renders a single app's result into a shareable 1080x1350 PNG card (drawn to
// a canvas), so each standalone app can let the user save/share its own result
// image. One renderer per app; they share the shell, palette, and helpers.

import type { HeartPulseResult, PersonalFrameResult } from "./types";
import { typeColor } from "./typeColors";
import { pokemonImageUrl } from "./pokematch/assets";
import { SEASON_GUIDE, FACE_SHAPE_TIP } from "./guidance";

export interface PersonalFrameLabels {
  season: Record<string, string>;
  undertone: Record<string, string>;
  faceShape: Record<string, string>;
  ita: Record<string, string>;
}

const W = 1080;
const H = 1350;
const PAD = 48;

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

function wrapTextKo(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines = 2
): number {
  let line = "";
  let linesCount = 0;
  let currentY = y;

  for (let i = 0; i < text.length; i++) {
    const testLine = line + text[i];
    if (ctx.measureText(testLine).width > maxWidth && line.length > 0) {
      if (linesCount === maxLines - 1) {
        ctx.fillText(line.trimEnd() + "…", x, currentY);
        return currentY + lineHeight;
      }
      ctx.fillText(line, x, currentY);
      line = text[i];
      currentY += lineHeight;
      linesCount++;
    } else {
      line = testLine;
    }
  }
  if (line.length > 0 && linesCount < maxLines) {
    ctx.fillText(line, x, currentY);
    currentY += lineHeight;
  }
  return currentY;
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
  opts: { appName: string; accent: string; measuredAt?: string; h?: number }
): number {
  const h = opts.h ?? H;
  const bg = ctx.createLinearGradient(0, 0, W, h);
  bg.addColorStop(0, COL.bg1);
  bg.addColorStop(1, COL.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, h);

  const glow = ctx.createRadialGradient(W * 0.85, 20, 40, W * 0.85, 20, 760);
  glow.addColorStop(0, hexToRgba(opts.accent, 0.14));
  glow.addColorStop(1, hexToRgba(opts.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  let y = 84;
  ctx.fillStyle = opts.accent;
  ctx.font = `700 24px ${SANS}`;
  ctx.fillText("VISIONLAB", PAD, y);

  y += 50;
  ctx.fillStyle = COL.text;
  ctx.font = `700 46px ${SANS}`;
  ctx.fillText(opts.appName, PAD, y);

  y += 36;
  const dateLabel = opts.measuredAt
    ? new Date(opts.measuredAt).toLocaleDateString("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";
  ctx.fillStyle = COL.textDim;
  ctx.font = `400 20px ${SANS}`;
  ctx.fillText(dateLabel, PAD, y);

  return y + 42;
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

  const startY = drawShell(ctx, { appName: "PersonalFrame", accent, measuredAt: result.measuredAt });

  const guide = SEASON_GUIDE[result.season];
  const cardX = PAD;
  const cardW = W - PAD * 2;
  const innerX = cardX + 32;

  // --- BLOCK 1: Tone & Color Summary Card (Y: startY, H: 260) ---
  const b1Y = startY;
  const b1H = 260;
  roundRect(ctx, cardX, b1Y, cardW, b1H, 24);
  ctx.fillStyle = COL.surface;
  ctx.fill();
  ctx.strokeStyle = COL.surfaceBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Swatch Box
  const swatchSize = 72;
  const swatchX = innerX;
  const swatchY = b1Y + 28;
  roundRect(ctx, swatchX, swatchY, swatchSize, swatchSize, 16);
  ctx.fillStyle = result.skinHex;
  ctx.fill();
  ctx.strokeStyle = COL.surfaceBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Hex & Lab
  ctx.fillStyle = COL.text;
  ctx.font = `700 28px ${MONO}`;
  ctx.fillText(result.skinHex.toUpperCase(), swatchX + swatchSize + 20, swatchY + 30);
  ctx.fillStyle = COL.textDim;
  ctx.font = `500 18px ${MONO}`;
  ctx.fillText(
    `L ${result.lab.L}  a ${result.lab.a}  b ${result.lab.b}`,
    swatchX + swatchSize + 20,
    swatchY + 60
  );

  // Confidence Tag (Right Top)
  ctx.fillStyle = COL.textMuted;
  ctx.font = `600 16px ${SANS}`;
  ctx.textAlign = "right";
  ctx.fillText(
    `측정 신뢰도 ${result.confidence}%${!result.ambientCorrected ? " (무보정)" : ""}`,
    cardX + cardW - 32,
    swatchY + 28
  );
  ctx.textAlign = "left";

  // Season & Undertone Title
  const seasonTitle = `${labels.season[result.season] ?? result.season} · ${labels.undertone[result.undertone] ?? result.undertone}`;
  ctx.fillStyle = accent;
  ctx.font = `800 26px ${SANS}`;
  ctx.fillText(seasonTitle, innerX, b1Y + 134);

  // Season Summary Text
  ctx.fillStyle = COL.textDim;
  ctx.font = `400 16px ${SANS}`;
  wrapTextKo(ctx, guide.summary, innerX, b1Y + 164, cardW - 64, 22, 1);

  // Mini Stats Row inside Block 1
  const miniY = b1Y + 196;
  const miniH = 46;
  const miniGap = 12;
  const miniW = (cardW - 64 - miniGap * 3) / 4;
  const miniItems = [
    { label: "언더톤", val: labels.undertone[result.undertone] ?? result.undertone },
    { label: "시즌", val: labels.season[result.season] ?? result.season },
    { label: "얼굴형", val: labels.faceShape[result.faceShape] ?? result.faceShape },
    { label: "ITA°", val: `${result.ita}°` },
  ];
  miniItems.forEach((item, idx) => {
    const mx = innerX + idx * (miniW + miniGap);
    roundRect(ctx, mx, miniY, miniW, miniH, 12);
    ctx.fillStyle = COL.base;
    ctx.fill();
    ctx.strokeStyle = COL.baseBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = COL.textMuted;
    ctx.font = `500 13px ${SANS}`;
    ctx.fillText(item.label, mx + 12, miniY + 18);
    ctx.fillStyle = COL.text;
    ctx.font = `700 15px ${SANS}`;
    ctx.fillText(item.val, mx + 12, miniY + 36);
  });

  // --- BLOCK 2: Palette Cards (Best & Avoid) (Y: b1Y + b1H + 16, H: 220) ---
  const b2Y = b1Y + b1H + 16;
  const b2H = 220;
  roundRect(ctx, cardX, b2Y, cardW, b2H, 24);
  ctx.fillStyle = COL.surface;
  ctx.fill();
  ctx.strokeStyle = COL.surfaceBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Section 2A: Best Colors
  ctx.fillStyle = accent;
  ctx.font = `700 18px ${SANS}`;
  ctx.fillText("어울리는 대표 컬러", innerX, b2Y + 34);

  let chipX = innerX;
  const chipY1 = b2Y + 48;
  const chipH = 34;
  const chipRadius = 10;

  guide.palette.slice(0, 5).forEach((c) => {
    ctx.font = `600 15px ${SANS}`;
    const textW = ctx.measureText(c.name).width;
    const cWidth = textW + 36;
    if (chipX + cWidth > cardX + cardW - 32) return;

    roundRect(ctx, chipX, chipY1, cWidth, chipH, chipRadius);
    ctx.fillStyle = COL.base;
    ctx.fill();
    ctx.strokeStyle = COL.baseBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Color dot
    ctx.beginPath();
    ctx.arc(chipX + 18, chipY1 + 17, 7, 0, Math.PI * 2);
    ctx.fillStyle = c.hex;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = COL.text;
    ctx.fillText(c.name, chipX + 30, chipY1 + 22);

    chipX += cWidth + 10;
  });

  // Section 2B: Avoid Colors
  ctx.fillStyle = "#8b4a3e";
  ctx.font = `700 18px ${SANS}`;
  ctx.fillText("피해야 할 컬러", innerX, b2Y + 124);

  let avoidX = innerX;
  const chipY2 = b2Y + 138;

  guide.avoid.slice(0, 4).forEach((c) => {
    ctx.font = `600 15px ${SANS}`;
    const textW = ctx.measureText(c.name).width;
    const cWidth = textW + 36;
    if (avoidX + cWidth > cardX + cardW - 32) return;

    roundRect(ctx, avoidX, chipY2, cWidth, chipH, chipRadius);
    ctx.fillStyle = COL.base;
    ctx.fill();
    ctx.strokeStyle = COL.baseBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(avoidX + 18, chipY2 + 17, 7, 0, Math.PI * 2);
    ctx.fillStyle = c.hex;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = COL.textDim;
    ctx.fillText(c.name, avoidX + 30, chipY2 + 22);

    avoidX += cWidth + 10;
  });

  // --- BLOCK 3: Style Recommendations (Y: b2Y + b2H + 16, H: 275) ---
  const b3Y = b2Y + b2H + 16;
  const b3H = 275;
  roundRect(ctx, cardX, b3Y, cardW, b3H, 24);
  ctx.fillStyle = COL.surface;
  ctx.fill();
  ctx.strokeStyle = COL.surfaceBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = COL.text;
  ctx.font = `700 19px ${SANS}`;
  ctx.fillText("이 톤, 이렇게 활용하세요", innerX, b3Y + 34);

  const styleRows = [
    { label: "메이크업", val: guide.makeup },
    { label: "헤어", val: guide.hair },
    { label: "액세서리", val: `${guide.metal} 계열 연출이 잘 어울려요.` },
    { label: "패션", val: guide.fashion },
  ];

  let rY = b3Y + 48;
  styleRows.forEach((row) => {
    ctx.fillStyle = accent;
    ctx.font = `700 15px ${SANS}`;
    ctx.fillText(row.label, innerX, rY + 18);

    ctx.fillStyle = COL.textDim;
    ctx.font = `400 15px ${SANS}`;
    wrapTextKo(ctx, row.val, innerX + 90, rY + 18, cardW - 154, 20, 2);
    rY += 54;
  });

  // --- BLOCK 4: Facial Geometry & Metrics (Y: b3Y + b3H + 16, H: 200) ---
  const b4Y = b3Y + b3H + 16;
  const b4H = 200;
  roundRect(ctx, cardX, b4Y, cardW, b4H, 24);
  ctx.fillStyle = COL.surface;
  ctx.fill();
  ctx.strokeStyle = COL.surfaceBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = COL.text;
  ctx.font = `700 19px ${SANS}`;
  ctx.fillText("얼굴형 & 골격 지표", innerX, b4Y + 34);

  const geoW = (cardW - 64 - 16 * 2) / 3;
  const geoY = b4Y + 48;
  const geoH = 62;
  const geoItems = [
    { label: "얼굴형", val: labels.faceShape[result.faceShape] ?? result.faceShape },
    { label: "길이/너비", val: `${result.metrics.lengthToWidth}` },
    { label: "턱선 형성각", val: `${result.metrics.jawAngle}°` },
  ];

  geoItems.forEach((g, idx) => {
    const gx = innerX + idx * (geoW + 16);
    roundRect(ctx, gx, geoY, geoW, geoH, 14);
    ctx.fillStyle = COL.base;
    ctx.fill();
    ctx.strokeStyle = COL.baseBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = COL.textMuted;
    ctx.font = `500 13px ${SANS}`;
    ctx.fillText(g.label, gx + 16, geoY + 22);
    ctx.fillStyle = COL.text;
    ctx.font = `700 18px ${SANS}`;
    ctx.fillText(g.val, gx + 16, geoY + 48);
  });

  // Face Shape Tip Text
  const shapeTip = FACE_SHAPE_TIP[result.faceShape];
  if (shapeTip) {
    ctx.fillStyle = COL.textDim;
    ctx.font = `400 15px ${SANS}`;
    wrapTextKo(ctx, `💡 ${shapeTip}`, innerX, b4Y + 138, cardW - 64, 21, 2);
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

export interface VrmMotionResult {
  snapshotDataUrl: string;
  vrmName?: string;
  fps?: number;
  faceTracked?: boolean;
  poseTracked?: boolean;
  handTracked?: boolean;
  measuredAt?: string;
}

const VRM_ACCENT = "#7b52b9";

export async function drawVrmMotionCard(
  canvas: HTMLCanvasElement,
  result: VrmMotionResult
): Promise<void> {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const startY = drawShell(ctx, { appName: "VRM Capture", accent: VRM_ACCENT, measuredAt: result.measuredAt });

  const cardX = PAD;
  const cardW = W - PAD * 2;

  // 1. Snapshot Container (Y: startY, H: 640)
  const snapY = startY;
  const snapH = 640;
  roundRect(ctx, cardX, snapY, cardW, snapH, 28);
  ctx.fillStyle = COL.surface;
  ctx.fill();
  ctx.strokeStyle = COL.surfaceBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  if (result.snapshotDataUrl) {
    const img = await loadImage(result.snapshotDataUrl);
    if (img) {
      ctx.save();
      roundRect(ctx, cardX + 8, snapY + 8, cardW - 16, snapH - 16, 24);
      ctx.clip();
      
      const aspectImg = img.width / img.height;
      const aspectBox = (cardW - 16) / (snapH - 16);
      let renderW = cardW - 16;
      let renderH = snapH - 16;
      let offX = cardX + 8;
      let offY = snapY + 8;

      if (aspectImg > aspectBox) {
        renderW = (snapH - 16) * aspectImg;
        offX = cardX + 8 - (renderW - (cardW - 16)) / 2;
      } else {
        renderH = (cardW - 16) / aspectImg;
        offY = snapY + 8 - (renderH - (snapH - 16)) / 2;
      }

      ctx.drawImage(img, offX, offY, renderW, renderH);
      ctx.restore();
    }
  }

  // 2. Motion Stats & Info Block (Y: snapY + snapH + 24, H: 240)
  const infoY = snapY + snapH + 24;
  const infoH = 240;
  roundRect(ctx, cardX, infoY, cardW, infoH, 24);
  ctx.fillStyle = COL.surface;
  ctx.fill();
  ctx.strokeStyle = COL.surfaceBorder;
  ctx.lineWidth = 2;
  ctx.stroke();

  const innerX = cardX + 32;
  ctx.fillStyle = VRM_ACCENT;
  ctx.font = `700 24px ${SANS}`;
  ctx.fillText("실시간 AI 3D 모션캡쳐 리포트", innerX, infoY + 44);

  const gap = 16;
  const statW = (cardW - 64 - gap * 2) / 3;
  const statsY = infoY + 68;

  const vrmLabel = result.vrmName || "Sample Avatar";
  const fpsLabel = result.fps ? `${Math.round(result.fps)} FPS` : "60 FPS";
  const trackingModes = [
    result.faceTracked !== false ? "얼굴" : null,
    result.poseTracked !== false ? "포즈" : null,
    result.handTracked ? "손" : null,
  ].filter(Boolean).join(" · ") || "전신 모션";

  drawStat(ctx, innerX, statsY, statW, "캐릭터 아바타", vrmLabel, { monoValue: false });
  drawStat(ctx, innerX + statW + gap, statsY, statW, "캡처 프레임", fpsLabel, { monoValue: true });
  drawStat(ctx, innerX + (statW + gap) * 2, statsY, statW, "트래킹 센서", trackingModes, { monoValue: false });

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
