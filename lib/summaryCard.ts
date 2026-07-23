// Renders the integrated HeartPulse + PersonalFrame results into a single
// shareable image (drawn to a canvas, exported as PNG) so users can save or
// share their combined report outside the app.

import type { HeartPulseResult, PersonalFrameResult } from "./types";

export interface SummaryCardLabels {
  season: Record<string, string>;
  undertone: Record<string, string>;
  faceShape: Record<string, string>;
}

const W = 1080;
const H = 1350;
const PAD = 64;

const SANS = "'Segoe UI', system-ui, 'Noto Sans KR', sans-serif";
const MONO = "'SFMono-Regular', ui-monospace, 'JetBrains Mono', monospace";

const COL = {
  bg1: "#1a1a21",
  bg2: "#16161c",
  surface: "#23232c",
  surfaceBorder: "rgba(255,255,255,0.08)",
  base: "#16161c",
  baseBorder: "rgba(255,255,255,0.07)",
  text: "#e9e9f1",
  textDim: "#a2a2b2",
  textMuted: "#6d6d7c",
  accent: "#92a9e1",
  rose: "#f78ca0",
};

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

export function drawSummaryCard(
  canvas: HTMLCanvasElement,
  data: { heart: HeartPulseResult | null; frame: PersonalFrameResult | null },
  labels: SummaryCardLabels
): void {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, COL.bg1);
  bg.addColorStop(1, COL.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.85, 20, 40, W * 0.85, 20, 760);
  glow.addColorStop(0, "rgba(146,169,225,0.18)");
  glow.addColorStop(1, "rgba(146,169,225,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  let y = 96;
  ctx.fillStyle = COL.accent;
  ctx.font = `700 26px ${SANS}`;
  ctx.fillText("VISIONLAB AI", PAD, y);

  y += 58;
  ctx.fillStyle = COL.text;
  ctx.font = `700 48px ${SANS}`;
  ctx.fillText("통합 결과지", PAD, y);

  y += 40;
  const dateSource = data.heart?.measuredAt ?? data.frame?.measuredAt;
  const dateLabel = dateSource
    ? new Date(dateSource).toLocaleDateString("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";
  ctx.fillStyle = COL.textDim;
  ctx.font = `400 22px ${SANS}`;
  ctx.fillText(dateLabel, PAD, y);

  y += 56;

  const cardX = PAD;
  const cardW = W - PAD * 2;

  if (data.heart) {
    const cardY = y;
    const cardH = 320;

    roundRect(ctx, cardX, cardY, cardW, cardH, 28);
    ctx.fillStyle = COL.surface;
    ctx.fill();
    ctx.strokeStyle = COL.surfaceBorder;
    ctx.lineWidth = 2;
    ctx.stroke();

    let iy = cardY + 56;
    ctx.fillStyle = COL.rose;
    ctx.font = `700 22px ${SANS}`;
    ctx.fillText("HEARTPULSE", cardX + 32, iy);

    iy += 78;
    const bpmText = `${data.heart.bpm}`;
    ctx.fillStyle = COL.text;
    ctx.font = `700 76px ${MONO}`;
    ctx.fillText(bpmText, cardX + 32, iy);
    const bpmWidth = ctx.measureText(bpmText).width;
    ctx.fillStyle = COL.textDim;
    ctx.font = `600 26px ${SANS}`;
    ctx.fillText("BPM", cardX + 32 + bpmWidth + 14, iy);

    const statsY = cardY + 200;
    const statW = (cardW - 32 * 2 - 20 * 2) / 3;
    drawStat(ctx, cardX + 32, statsY, statW, "스트레스", `${data.heart.stressIndex}`, {
      unit: "/100",
    });
    drawStat(ctx, cardX + 32 + statW + 20, statsY, statW, "신뢰도", `${data.heart.confidence}`, {
      unit: "%",
    });
    drawStat(
      ctx,
      cardX + 32 + (statW + 20) * 2,
      statsY,
      statW,
      "SDNN",
      `${Math.round(data.heart.sdnn)}`,
      { unit: "ms" }
    );

    y = cardY + cardH + 32;
  }

  if (data.frame) {
    const cardY = y;
    const cardH = 380;

    roundRect(ctx, cardX, cardY, cardW, cardH, 28);
    ctx.fillStyle = COL.surface;
    ctx.fill();
    ctx.strokeStyle = COL.surfaceBorder;
    ctx.lineWidth = 2;
    ctx.stroke();

    const iy = cardY + 56;
    ctx.fillStyle = COL.accent;
    ctx.font = `700 22px ${SANS}`;
    ctx.fillText("PERSONALFRAME", cardX + 32, iy);

    const swatchSize = 84;
    const swatchX = cardX + 32;
    const swatchY = iy + 30;
    roundRect(ctx, swatchX, swatchY, swatchSize, swatchSize, 18);
    ctx.fillStyle = data.frame.skinHex;
    ctx.fill();
    ctx.strokeStyle = COL.surfaceBorder;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = COL.text;
    ctx.font = `700 30px ${MONO}`;
    ctx.fillText(data.frame.skinHex.toUpperCase(), swatchX + swatchSize + 24, swatchY + 34);
    ctx.fillStyle = COL.textDim;
    ctx.font = `500 20px ${MONO}`;
    ctx.fillText(
      `L ${data.frame.lab.L}  a ${data.frame.lab.a}  b ${data.frame.lab.b}`,
      swatchX + swatchSize + 24,
      swatchY + 66
    );

    const statsY = swatchY + swatchSize + 36;
    const statW = (cardW - 32 * 2 - 20 * 2) / 3;
    drawStat(
      ctx,
      cardX + 32,
      statsY,
      statW,
      "언더톤",
      labels.undertone[data.frame.undertone] ?? data.frame.undertone,
      { monoValue: false }
    );
    drawStat(
      ctx,
      cardX + 32 + statW + 20,
      statsY,
      statW,
      "시즌 톤",
      labels.season[data.frame.season] ?? data.frame.season,
      { monoValue: false }
    );
    drawStat(
      ctx,
      cardX + 32 + (statW + 20) * 2,
      statsY,
      statW,
      "얼굴형",
      labels.faceShape[data.frame.faceShape] ?? data.frame.faceShape,
      { monoValue: false }
    );

    y = cardY + cardH + 32;
  }

  ctx.fillStyle = COL.textMuted;
  ctx.font = `500 18px ${SANS}`;
  ctx.textAlign = "center";
  ctx.fillText("모든 측정은 기기 내(온디바이스)에서 실시간으로 계산됩니다", W / 2, H - 48);
  ctx.textAlign = "left";
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}
