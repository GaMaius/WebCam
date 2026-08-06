// Loads the real Spider-Man FBX headlessly and reports what our rigger sees.
// three's ImageLoader needs a DOM, so stub just enough for texture loads to be
// no-ops — we only care about the skeleton here.
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
import { classifyBoneName } from "../lib/vrm/humanoidRigger.ts";

const path = "public/models/spider-man-brand-new-day/source/Spider-Man Brand New Day.fbx";
const buf = fs.readFileSync(path);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new FBXLoader();
let root;
try {
  root = loader.parse(ab, "");
} catch (err) {
  console.log("PARSE FAILED:", err.message);
  process.exit(1);
}

let bones = 0,
  meshes = 0,
  skinned = 0,
  morphs = 0;
const boneNames = [];
const matNames = new Set();
root.traverse((o) => {
  if (o.isBone) {
    bones++;
    boneNames.push(o.name);
  }
  if (o.isMesh) {
    meshes++;
    if (o.isSkinnedMesh) skinned++;
    if (o.morphTargetDictionary) morphs += Object.keys(o.morphTargetDictionary).length;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m) matNames.add(m.name || "(unnamed)");
  }
});

const box = new THREE.Box3().setFromObject(root);
const size = box.getSize(new THREE.Vector3());

console.log("=== FBX ===");
console.log("bones:", bones, "| meshes:", meshes, "| skinned:", skinned, "| morph targets:", morphs);
console.log("bbox size:", size.toArray().map((v) => v.toFixed(1)).join(" x "));
console.log("materials:", [...matNames].join(", "));
console.log("animations:", root.animations?.length ?? 0);

console.log("\n=== bone names (first 60) ===");
console.log(boneNames.slice(0, 60).join("\n"));

console.log("\n=== our mapping ===");
const mapped = {};
for (const n of boneNames) {
  const slot = classifyBoneName(n);
  if (slot && !(slot in mapped)) mapped[slot] = n;
}
const REQUIRED = [
  "hips",
  "spine",
  "head",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
];
for (const [k, v] of Object.entries(mapped)) console.log(`  ${k.padEnd(16)} <- ${v}`);
const missing = REQUIRED.filter((r) => !(r in mapped));
console.log("\nMISSING REQUIRED:", missing.length ? missing.join(", ") : "(none)");

// --- skeleton sharing: do the skinned meshes share ONE bone hierarchy? ---
console.log("\n=== skeletons ===");
const skinnedMeshes = [];
root.traverse((o) => { if (o.isSkinnedMesh) skinnedMeshes.push(o); });
const hipsPerMesh = skinnedMeshes.map((m) => {
  const hips = m.skeleton.bones.find((b) => /hips/i.test(b.name));
  return { mesh: m.name, bones: m.skeleton.bones.length, hips };
});
for (const h of hipsPerMesh) console.log(`  ${h.mesh}: ${h.bones} bones, hips=${h.hips ? h.hips.uuid.slice(0,8) : "none"}`);
const uniqueHips = new Set(hipsPerMesh.map((h) => h.hips?.uuid));
console.log("distinct hips objects across meshes:", uniqueHips.size);

// Where do the bone roots live?
const boneRoots = [];
root.traverse((o) => { if (o.isBone && !(o.parent && o.parent.isBone)) boneRoots.push({ name: o.name, parent: o.parent?.name, parentType: o.parent?.type }); });
console.log("\nbone-hierarchy roots:", boneRoots.length);
for (const b of boneRoots.slice(0, 10)) console.log(`  ${b.name} (parent: ${b.parent} [${b.parentType}])`);

// --- exact structure of the duplicated bones ---
console.log("\n=== tree (first 24 nodes, with depth) ===");
let shown = 0;
(function walk(node, depth) {
  if (shown++ < 24) console.log(`${"  ".repeat(depth)}${node.type}:${node.name} (children ${node.children.length}, pos ${node.position.toArray().map(v=>v.toFixed(1)).join(",")})`);
  for (const c of node.children) walk(c, depth + 1);
})(root, 0);

// Are the same-named copies nested (ancestor chain) or siblings?
const byName = new Map();
root.traverse((o) => { if (o.isBone) { if (!byName.has(o.name)) byName.set(o.name, []); byName.get(o.name).push(o); } });
const hipsCopies = byName.get("mixamorigHips") ?? [];
console.log("\nmixamorigHips copies:", hipsCopies.length);
for (const b of hipsCopies) {
  const chain = [];
  let p = b.parent;
  while (p) { chain.push(p.name || p.type); p = p.parent; }
  console.log(`  uuid ${b.uuid.slice(0,8)} depth-chain: ${chain.reverse().join(" > ")}`);
}
// Does driving the topmost copy move the ones the meshes actually use?
const top = hipsCopies[0];
const isAncestorOfAll = hipsCopies.every((b) => { let p = b; while (p) { if (p === top) return true; p = p.parent; } return false; });
console.log("topmost copy is an ancestor of every other copy:", isAncestorOfAll);

// --- run the real rigger end-to-end on this model ---
import { buildHumanoidRig } from "../lib/vrm/humanoidRigger.ts";
console.log("\n=== buildHumanoidRig on the real model ===");
const rig = buildHumanoidRig(root);
console.log("notes:", rig.notes);
const wp = (n) => { n.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(n.matrixWorld); };
const head = wp(rig.humanoid.getRawBoneNode("head"));
const lFoot = wp(rig.humanoid.getRawBoneNode("leftFoot"));
console.log(`head y=${head.y.toFixed(3)}  leftFoot y=${lFoot.y.toFixed(3)}`);
for (const side of ["left", "right"]) {
  const up = wp(rig.humanoid.getRawBoneNode(`${side}UpperArm`));
  const hand = wp(rig.humanoid.getRawBoneNode(`${side}Hand`));
  const d = hand.clone().sub(up).normalize();
  console.log(`${side} arm rest dir: ${d.toArray().map(v=>v.toFixed(2)).join(", ")}`);
}

// The end-to-end check: does a side-raise actually raise the hand, and do ALL
// meshes follow (i.e. does the deepest bone copy the meshes bind to move too)?
const scene = new THREE.Scene();
scene.add(root); scene.add(rig.rigRoot); scene.updateMatrixWorld(true);
const deepestHips = hipsCopies[hipsCopies.length - 1];
const beforeHand = wp(rig.humanoid.getRawBoneNode("leftHand"));
const beforeDeep = wp(deepestHips);
rig.humanoid.getNormalizedBoneNode("leftUpperArm").quaternion.setFromEuler(new THREE.Euler(0, 0, -0.6, "XYZ"));
rig.humanoid.getNormalizedBoneNode("hips").quaternion.setFromEuler(new THREE.Euler(0, 0.3, 0, "XYZ"));
rig.humanoid.update();
scene.updateMatrixWorld(true);
const dHand = wp(rig.humanoid.getRawBoneNode("leftHand")).sub(beforeHand);
const dDeepQuat = new THREE.Quaternion(); deepestHips.getWorldQuaternion(dDeepQuat);
console.log(`side-raise -> hand delta: ${dHand.toArray().map(v=>v.toFixed(3)).join(", ")} (dy>0 means UP)`);
console.log(`deepest hips copy world rotation after hip yaw: y=${new THREE.Euler().setFromQuaternion(dDeepQuat,"YXZ").y.toFixed(3)} rad (should be ~0.3 => all 7 meshes follow)`);
