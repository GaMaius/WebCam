// Leave-one-out validation of the webcam μ recalibration.
//
// For each collected face, rebuild mu_eff from the OTHER faces only, rank the
// held-out face, and report overlap across the held-out top-lists. Low overlap
// = the recalibration generalizes (results are person-specific, no shared hub).
//
// Usage:  node ml/pokematch/calibration/validate_loo.mjs

import fs from "node:fs";
import path from "node:path";

const GALLERY = "public/pokemon/gallery.json";
const FACES_DIR = "ml/pokematch/calibration/faces";

const g = JSON.parse(fs.readFileSync(GALLERY, "utf8"));
const { species } = g;
const N = species.length;
const muRaw = g.muRaw ?? g.mu;
const sdRaw = g.sdRaw ?? g.sd;

const files = fs.readdirSync(FACES_DIR).filter((f) => f.endsWith(".txt")).sort();
const faces = files.map((f) => fs.readFileSync(path.join(FACES_DIR, f), "utf8").trim().split(",").map((x) => +x / 1000));

const sortedSd = sdRaw.slice().sort((a, b) => a - b);
const pct = (p) => sortedSd[Math.floor(sortedSd.length * p)];

function rank(cos, muEff, floor, k = 6) {
  const sc = [];
  for (let s = 0; s < N; s++) sc.push({ s, z: (cos[s] - muEff[s]) / Math.max(sdRaw[s], floor) });
  sc.sort((a, b) => b.z - a.z);
  return sc.slice(0, k).map((x) => species[x.s]);
}

for (const LAMBDA of [0.5, 0.7, 1.0]) {
  for (const FP of [0.3]) {
    const floor = pct(FP);
    console.log(`\n=== LOO  λ=${LAMBDA}  floor=p${FP * 100}(${floor.toFixed(4)}) ===`);
    const tops = [];
    files.forEach((name, ti) => {
      const others = faces.filter((_, i) => i !== ti);
      const muEff = muRaw.map((m, s) => {
        const wm = others.reduce((a, f) => a + f[s], 0) / others.length;
        return (1 - LAMBDA) * m + LAMBDA * wm;
      });
      const t = rank(faces[ti], muEff, floor);
      tops.push(t);
      console.log("  ", name.padEnd(12), t.join(", "));
    });
    const counts = {};
    for (const t of tops) for (const s of t) counts[s] = (counts[s] || 0) + 1;
    const shared = Object.entries(counts).filter(([, c]) => c >= Math.ceil(files.length * 0.75)).map(([s, c]) => `${s}:${c}`);
    console.log("   shared across >=75% of faces:", shared.join(" ") || "(none — good)");
  }
}
