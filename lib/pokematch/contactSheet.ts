// Draws the stage-2 contact sheet: the face crop on the left, the stage-1
// picks' official artwork in numbered panels on the right. Sent as ONE image
// because this endpoint bills images at a flat rate regardless of size (see
// the rerank notes in judgeProtocol.ts).
//
// Browser-only (canvas + Image).

import { pokemonImageUrl } from "./assets";

/** Face square and each Pokemon panel are this many pixels. */
const FACE_SIDE = 448;
const CELL = 224;
const COLS = 4;
const SHEET_QUALITY = 0.85;
const LOAD_TIMEOUT_MS = 6000;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // The art may come from the asset CDN; without CORS the canvas is tainted
    // and toDataURL throws.
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = src;
  });
}

/**
 * Returns the sheet as a JPEG data URL plus the slugs in panel order (panel 1
 * is index 0). Species whose artwork fails to load are left OUT rather than
 * drawn as empty panels — an empty panel would still get ranked. Null when
 * fewer than two panels survive (nothing to compare).
 */
export async function buildContactSheet(
  faceDataUrl: string,
  slugs: string[]
): Promise<{ dataUrl: string; slugs: string[] } | null> {
  const [face, ...arts] = await Promise.all([
    loadImage(faceDataUrl),
    ...slugs.map((s) => loadImage(pokemonImageUrl(s))),
  ]);
  if (!face) return null;
  const panels = slugs
    .map((slug, i) => ({ slug, img: arts[i] }))
    .filter((p): p is { slug: string; img: HTMLImageElement } => p.img !== null);
  if (panels.length < 2) return null;

  const rows = Math.ceil(panels.length / COLS);
  const canvas = document.createElement("canvas");
  canvas.width = FACE_SIDE + COLS * CELL;
  canvas.height = Math.max(FACE_SIDE, rows * CELL);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(face, 0, 0, FACE_SIDE, FACE_SIDE);
  // A divider so the face square reads as a separate thing from the panels.
  ctx.fillStyle = "#222222";
  ctx.fillRect(FACE_SIDE, 0, 4, canvas.height);

  panels.forEach(({ img }, i) => {
    const x = FACE_SIDE + (i % COLS) * CELL;
    const y = Math.floor(i / COLS) * CELL;
    ctx.strokeStyle = "#d0d0d0";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
    // Fit the artwork inside the cell, leaving room for the number badge.
    const pad = 18;
    const box = CELL - pad * 2;
    const scale = Math.min(box / img.naturalWidth, box / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, x + (CELL - w) / 2, y + (CELL - h) / 2 + 6, w, h);
    // Number badge, large and high-contrast so the model reads it reliably.
    ctx.fillStyle = "#111111";
    ctx.beginPath();
    ctx.arc(x + 24, y + 24, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 22px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), x + 24, y + 25);
  });

  try {
    return { dataUrl: canvas.toDataURL("image/jpeg", SHEET_QUALITY), slugs: panels.map((p) => p.slug) };
  } catch {
    return null; // tainted canvas (asset host without CORS)
  }
}
