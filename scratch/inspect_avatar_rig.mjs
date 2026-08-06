// Headless report on what lib/vrm/humanoidRigger.ts sees in an FBX/glTF rig:
// bone-name mapping, the auto-fixes it applies, and whether a tracker-style
// rotation actually moves the skeleton the right way. Use this before wiring a
// new avatar — it answers "will this model work?" without a browser or a webcam.
//
//   node scratch/inspect_avatar_rig.mjs path/to/model.fbx
//
// three's ImageLoader needs a DOM, so stub just enough for texture loads to be
// no-ops — only the skeleton matters here.
globalThis.document = {
  createElementNS: () => ({
    addEventListener() {},
    removeEventListener() {},
    style: {},
    set src(_v) {},
    get src() {
      return "";
    },
  }),
  createElement: () => ({ style: {}, getContext: () => null }),
};
globalThis.self = globalThis;

import fs from "node:fs";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { buildHumanoidRig, classifyBoneName } from "../lib/vrm/humanoidRigger.ts";

const REQUIRED = [
  "hips", "spine", "head",
  "leftUpperArm", "leftLowerArm", "leftHand",
  "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot",
  "rightUpperLeg", "rightLowerLeg", "rightFoot",
];

const file = process.argv[2];
if (!file) {
  console.error("usage: node scratch/inspect_avatar_rig.mjs <model.fbx>");
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(1);
}

const buf = fs.readFileSync(file);
const root = new FBXLoader().parse(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  ""
);

const wp = (n) => {
  n.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(n.matrixWorld);
};

// --- what's in the file ---
const boneNames = [];
const matNames = new Set();
let meshes = 0,
  skinned = 0,
  morphs = 0;
root.traverse((o) => {
  if (o.isBone) boneNames.push(o.name);
  if (o.isMesh) {
    meshes++;
    if (o.isSkinnedMesh) skinned++;
    if (o.morphTargetDictionary) morphs += Object.keys(o.morphTargetDictionary).length;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m) matNames.add(m.name || "(unnamed)");
    }
  }
});
const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());

console.log("=== file ===");
console.log(
  `bones ${boneNames.length} | meshes ${meshes} (skinned ${skinned}) | morph targets ${morphs}`
);
console.log(`bbox ${size.toArray().map((v) => v.toFixed(1)).join(" x ")}`);
console.log(`materials: ${[...matNames].join(", ")}`);

// --- duplicated skeletons: only safe if the copies nest ---
const byName = new Map();
root.traverse((o) => {
  if (!o.isBone) return;
  if (!byName.has(o.name)) byName.set(o.name, []);
  byName.get(o.name).push(o);
});
const dupes = [...byName.entries()].filter(([, v]) => v.length > 1);
if (dupes.length) {
  const [name, copies] = dupes[0];
  const top = copies[0];
  const nested = copies.every((b) => {
    let p = b;
    while (p) {
      if (p === top) return true;
      p = p.parent;
    }
    return false;
  });
  console.log(`\n${dupes.length} bone names are duplicated (e.g. ${name} x${copies.length}).`);
  console.log(
    `topmost copy is an ancestor of all others: ${nested}` +
      (nested
        ? "  -> min-depth bone pick drives every mesh"
        : "  -> WARNING: separate skeletons, some meshes will not follow")
  );
}

// --- mapping ---
console.log("\n=== mapping ===");
const mapped = {};
for (const n of boneNames) {
  const slot = classifyBoneName(n);
  if (slot && !(slot in mapped)) mapped[slot] = n;
}
for (const [k, v] of Object.entries(mapped)) console.log(`  ${k.padEnd(16)} <- ${v}`);
const missing = REQUIRED.filter((r) => !(r in mapped));
console.log("missing required:", missing.length ? missing.join(", ") : "(none)");
if (missing.length) process.exit(1);

// --- the rigger's own fixes ---
console.log("\n=== buildHumanoidRig ===");
const rig = buildHumanoidRig(root);
console.log("auto-fixes:", rig.notes.length ? rig.notes : "(none needed)");
console.log(
  `head y=${wp(rig.humanoid.getRawBoneNode("head")).y.toFixed(3)}  ` +
    `leftFoot y=${wp(rig.humanoid.getRawBoneNode("leftFoot")).y.toFixed(3)}`
);
for (const side of ["left", "right"]) {
  const up = wp(rig.humanoid.getRawBoneNode(`${side}UpperArm`));
  const hand = wp(rig.humanoid.getRawBoneNode(`${side}Hand`));
  const d = hand.clone().sub(up).normalize();
  // After the rest-pose fix these must be ~(-1,0,0) and (1,0,0): a real T-pose,
  // which is the zero Kalidokit solves against.
  console.log(`${side} arm rest dir: ${d.toArray().map((v) => v.toFixed(2)).join(", ")}`);
}

// --- end-to-end: does a side-raise raise the hand? ---
const scene = new THREE.Scene();
scene.add(root);
scene.add(rig.rigRoot);
scene.updateMatrixWorld(true);

const before = wp(rig.humanoid.getRawBoneNode("leftHand"));
rig.humanoid
  .getNormalizedBoneNode("leftUpperArm")
  .quaternion.setFromEuler(new THREE.Euler(0, 0, -0.6, "XYZ"));
rig.humanoid.update();
scene.updateMatrixWorld(true);
const delta = wp(rig.humanoid.getRawBoneNode("leftHand")).sub(before);

console.log(
  `\nside-raise -> hand delta ${delta.toArray().map((v) => v.toFixed(3)).join(", ")} ` +
    `(dy must be > 0, i.e. UP)`
);
process.exit(delta.y > 0 ? 0 : 1);
