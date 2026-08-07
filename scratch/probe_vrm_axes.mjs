// Ground truth for the VRM axis conventions, measured off the real avatar
// instead of reasoned about. Loads public/models/avatar.vrm headlessly (textures
// stubbed out — only the skeleton matters) and answers:
//
//   1. Which world X side is the character's LEFT?
//   2. Which way does the palm face in the rest pose?
//   3. Which sign of a normalized finger bone's local Z curls the finger toward
//      the palm (i.e. makes a fist) rather than hyperextending it?
//
//   node scratch/probe_vrm_axes.mjs

// three's ImageLoader waits for a load event, so the stub has to fire one or the
// parse never settles.
const stubEl = () => {
  const listeners = {};
  return {
    addEventListener(type, cb) {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener() {},
    style: {},
    width: 1,
    height: 1,
    set src(_v) {
      setTimeout(() => (listeners.load ?? []).forEach((cb) => cb()), 0);
    },
    get src() {
      return "";
    },
  };
};
globalThis.document = { createElementNS: stubEl, createElement: stubEl };
globalThis.self = globalThis;
// GLTFLoader hands embedded images to the loader as blob URLs.
URL.createObjectURL ??= () => "blob:stub";
URL.revokeObjectURL ??= () => {};

import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";

const file = process.argv[2] ?? "public/models/avatar.vrm";
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

const gltf = await new Promise((resolve, reject) => {
  loader.parse(ab, "", resolve, reject);
});
const vrm = gltf.userData.vrm;
if (!vrm) throw new Error("no VRM extension found");

const scene = new THREE.Scene();
scene.add(vrm.scene);
scene.add(vrm.humanoid.normalizedHumanBonesRoot);
scene.updateMatrixWorld(true);

const wp = (name) => {
  const n = vrm.humanoid.getRawBoneNode(name);
  if (!n) return null;
  n.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(n.matrixWorld);
};
const fmt = (v) => `(${v.toArray().map((n) => n.toFixed(3)).join(", ")})`;

console.log(`=== ${file} ===`);
console.log(`meta: VRM ${vrm.meta?.metaVersion ?? "?"}`);

// 1. Which side is the character's left?
const lArm = wp("leftUpperArm");
const rArm = wp("rightUpperArm");
console.log(`\nleftUpperArm  ${fmt(lArm)}`);
console.log(`rightUpperArm ${fmt(rArm)}`);
console.log(
  `=> the character's LEFT is on world ${lArm.x > rArm.x ? "+X" : "-X"}`
);

// 2. Rest orientation of the left hand: finger direction and palm normal.
const wrist = wp("leftHand");
const indexP = wp("leftIndexProximal");
const indexD = wp("leftIndexDistal");
const littleP = wp("leftLittleProximal");

const fingerDir = indexD.clone().sub(indexP).normalize();
const acrossPalm = littleP.clone().sub(indexP).normalize();
// Normal of the palm plane. Sign convention: which way the back of the hand
// faces depends on the cross order, so report both and interpret via the curl
// test below.
const palmNormal = new THREE.Vector3().crossVectors(fingerDir, acrossPalm).normalize();

console.log(`\nleft wrist          ${fmt(wrist)}`);
console.log(`left index prox->dist dir ${fmt(fingerDir)}`);
console.log(`index->little (across palm) ${fmt(acrossPalm)}`);
console.log(`palm plane normal   ${fmt(palmNormal)}`);

// 3. Curl test: rotate the normalized finger bone by +Z and by -Z, and see which
// way the fingertip moves. A fist curls the tip toward the PALM side.
function tipAfterZ(boneName, tipName, z) {
  vrm.humanoid.resetNormalizedPose();
  vrm.humanoid.update();
  scene.updateMatrixWorld(true);
  const before = wp(tipName).clone();

  const node = vrm.humanoid.getNormalizedBoneNode(boneName);
  node.quaternion.setFromEuler(new THREE.Euler(0, 0, z, "XYZ"));
  vrm.humanoid.update();
  scene.updateMatrixWorld(true);
  const after = wp(tipName).clone();

  vrm.humanoid.resetNormalizedPose();
  vrm.humanoid.update();
  scene.updateMatrixWorld(true);
  return after.sub(before);
}

for (const [side, bone, tip] of [
  ["left", "leftIndexProximal", "leftIndexDistal"],
  ["right", "rightIndexProximal", "rightIndexDistal"],
]) {
  const plus = tipAfterZ(bone, tip, 1.0);
  const minus = tipAfterZ(bone, tip, -1.0);

  // Recompute this side's palm normal.
  const p = wp(`${side}IndexProximal`);
  const d = wp(`${side}IndexDistal`);
  const l = wp(`${side}LittleProximal`);
  const dir = d.clone().sub(p).normalize();
  const across = l.clone().sub(p).normalize();
  const normal = new THREE.Vector3().crossVectors(dir, across).normalize();

  // A curl also shortens the wrist->tip span; use that as the primary signal and
  // report the normal-projection so the palm side is identifiable.
  const w = wp(`${side}Hand`);
  const restSpan = w.distanceTo(d);
  const spanPlus = w.distanceTo(d.clone().add(plus));
  const spanMinus = w.distanceTo(d.clone().add(minus));

  console.log(`\n--- ${side} index finger ---`);
  console.log(`  +Z tip delta ${fmt(plus)}  | along palm normal ${plus.dot(normal).toFixed(4)} | wrist span ${restSpan.toFixed(4)} -> ${spanPlus.toFixed(4)}`);
  console.log(`  -Z tip delta ${fmt(minus)} | along palm normal ${minus.dot(normal).toFixed(4)} | wrist span ${restSpan.toFixed(4)} -> ${spanMinus.toFixed(4)}`);
}
