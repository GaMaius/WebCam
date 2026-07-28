// PokéMatch webcam μ recalibration.
//
// Why: the gallery's per-species mu/sd were computed on LFW faces, which
// resemble round "face-like" species far less than real webcam selfies do,
// so every webcam face's z-scores lit up the same cluster (everyone → Mew).
// Fix: blend the LFW mu toward the *mean cosine of real webcam faces* and
// floor sd so small-sd species can't become the new hub.
//
// Data: ml/pokematch/calibration/faces/*.txt — each file is ONE real face's
// FULLCOS line from the app's ?debug panel (per-species cosine in
// gallery.species order, integers x1000, comma-separated). Add more faces by
// pasting new ?debug FULLCOS lines as faceNN.txt, then re-run.
//
// Usage (from repo root):
//   node ml/pokematch/calibration/recalibrate.mjs         # dry-run: print rankings
//   node ml/pokematch/calibration/recalibrate.mjs write   # write public/pokemon/gallery.json
//
// Tunables below (LAMBDA, FLOOR_PCT) — see ml/pokematch/calibration/README.md.

import fs from "node:fs";
import path from "node:path";

const LAMBDA = Number(process.env.LAMBDA ?? 0.4); // mu_eff = (1-λ)·muRaw + λ·webcamMean
const FLOOR_PCT = 0.5; // Floor sd at 50th percentile (approx 0.055) to prevent small-sd outliers (muk/amoonguss) from exploding z-scores

const GALLERY = "public/pokemon/gallery.json";
const FACES_DIR = "ml/pokematch/calibration/faces";
const DRY = process.argv[2] !== "write";

const g = JSON.parse(fs.readFileSync(GALLERY, "utf8"));
const { species } = g;
const N = species.length;
// Always recalibrate from the ORIGINAL raw stats (supports re-running).
const muRaw = g.muRaw ?? g.mu;
const sdRaw = g.sdRaw ?? g.sd;

const faceFiles = fs
  .readdirSync(FACES_DIR)
  .filter((f) => f.endsWith(".txt"))
  .sort();
if (faceFiles.length === 0) throw new Error(`no face files in ${FACES_DIR}`);
const faces = faceFiles.map((f) => {
  const v = fs.readFileSync(path.join(FACES_DIR, f), "utf8").trim().split(",").map((x) => +x / 1000);
  if (v.length !== N) throw new Error(`${f}: expected ${N} values, got ${v.length}`);
  return v;
});
console.log(`faces=${faces.length} (${faceFiles.join(", ")})  LAMBDA=${LAMBDA}  FLOOR_PCT=${FLOOR_PCT}`);

const webcamMean = new Array(N);
for (let s = 0; s < N; s++) webcamMean[s] = faces.reduce((a, f) => a + f[s], 0) / faces.length;

const sortedSd = sdRaw.slice().sort((a, b) => a - b);
const sdFloor = sortedSd[Math.floor(sortedSd.length * FLOOR_PCT)];

const muEff = muRaw.map((m, s) => (1 - LAMBDA) * m + LAMBDA * webcamMean[s]);
const sdEff = sdRaw.map((v) => Math.max(v, sdFloor));

function rank(cos, k = 6) {
  const sc = [];
  for (let s = 0; s < N; s++) sc.push({ s, z: (cos[s] - muEff[s]) / (sdEff[s] || 1e-6) });
  sc.sort((a, b) => b.z - a.z);
  return sc.slice(0, k).map((x) => species[x.s]);
}
console.log(`sdFloor=${sdFloor.toFixed(4)}`);
faceFiles.forEach((f, i) => console.log("  ", f.padEnd(12), rank(faces[i]).join(", ")));

if (!DRY) {
  const round = (x) => Math.round(x * 1e5) / 1e5;
  const out = {
    ...g,
    mu: muEff.map(round),
    sd: sdEff.map(round),
    muRaw: muRaw.map(round),
    sdRaw: sdRaw.map(round),
    calibration: {
      method: "webcam-mu-blend",
      faces: faces.length,
      lambda: LAMBDA,
      sdFloorPct: FLOOR_PCT,
      sdFloor: round(sdFloor),
    },
  };
  fs.writeFileSync(GALLERY, JSON.stringify(out));
  console.log("WROTE", GALLERY, "bytes", fs.statSync(GALLERY).size);
}
