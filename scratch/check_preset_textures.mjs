// Cross-checks the spiderman preset's material->texture table against the real
// FBX's material names and the files on disk. Catches typos, missing tiles and
// materials that would silently render untextured.
globalThis.document={createElementNS:()=>({addEventListener(){},removeEventListener(){},style:{},set src(v){},get src(){return ''}}),createElement:()=>({style:{},getContext:()=>null})};
globalThis.self=globalThis;
import fs from "node:fs";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { AVATAR_PRESETS } from "../lib/vrm/avatarPresets.ts";

const preset = AVATAR_PRESETS.find((p) => p.id === "spiderman");
const fbxPath = "public" + preset.url;
const buf = fs.readFileSync(fbxPath);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");

const materials = new Map();
root.traverse((o) => {
  if (!o.isMesh) return;
  for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
    if (!m) continue;
    if (!materials.has(m.name)) materials.set(m.name, new Set());
    materials.get(m.name).add(o.name);
  }
});

const rules = new Map(preset.textures.map((r) => [r.material, r]));
let missingFiles = 0, unmatched = [];

console.log("material            meshes                     baseColor / normal");
for (const [name, meshes] of materials) {
  const r = rules.get(name);
  const files = r ? [r.baseColor, r.normal].filter(Boolean) : [];
  const missing = files.filter((f) => !fs.existsSync("public" + preset.textureBase + f));
  missingFiles += missing.length;
  if (!r) unmatched.push(name);
  console.log(
    `${name.padEnd(20)}${[...meshes].join(",").padEnd(27)}` +
      (r ? `${r.baseColor} / ${r.normal}` : "(no rule -> untextured)") +
      (missing.length ? `   MISSING: ${missing.join(", ")}` : "")
  );
}

const orphanRules = [...rules.keys()].filter((k) => !materials.has(k));
console.log(`\nmaterials: ${materials.size} | rules: ${rules.size}`);
console.log("materials with no rule:", unmatched.length ? unmatched.join(", ") : "(none)");
console.log("rules matching no material:", orphanRules.length ? orphanRules.join(", ") : "(none)");
console.log("missing texture files:", missingFiles);
process.exit(missingFiles || orphanRules.length ? 1 : 0);
