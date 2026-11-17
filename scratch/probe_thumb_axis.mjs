// Which axis actually curls the avatar's THUMB toward the palm?
//
// boneRig currently drives all five digits on local Z, on the strength of a note
// saying the thumb measured the same as the fingers. On a real device the thumb
// bends BACKWARDS, so that note is suspect. Anatomically it would be: the thumb's
// metacarpal is rotated out of the palm plane, so its local axes don't line up
// with the other four.
//
// This sweeps each local axis, both signs, for the thumb and (as a control) the
// index, and reports which one moves the tip toward the palm. Measured, not
// reasoned.
//
// Run: node scratch/probe_thumb_axis.mjs

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
URL.createObjectURL ??= () => "blob:stub";
URL.revokeObjectURL ??= () => {};

const fs = await import("node:fs");
const THREE = await import("three");
const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
const { VRMLoaderPlugin } = await import("@pixiv/three-vrm");

const buf = fs.readFileSync("public/models/avatar.vrm");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
const gltf = await new Promise((res, rej) => loader.parse(ab, "", res, rej));
const vrm = gltf.userData.vrm;

const scene = new THREE.Scene();
scene.add(vrm.scene);
scene.add(vrm.humanoid.normalizedHumanBonesRoot);
scene.updateMatrixWorld(true);

const node = (n) => vrm.humanoid.getNormalizedBoneNode(n) || vrm.humanoid.getRawBoneNode(n);
const worldOf = (n) => {
  const b = vrm.humanoid.getRawBoneNode(n);
  b.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
};

const settle = () => {
  vrm.humanoid.update();
  scene.updateMatrixWorld(true);
};

// The palm direction at rest. VRM's rest pose is a T-pose with palms DOWN, so the
// palm faces -Y for both hands (probe_vrm_axes.mjs measured this; it is NOT
// derivable from a cross product, which flips sign between mirrored hands).
const PALM = new THREE.Vector3(0, -1, 0);

const CHAINS = {
  thumb: ["ThumbMetacarpal", "ThumbProximal", "ThumbDistal"],
  index: ["IndexProximal", "IndexIntermediate", "IndexDistal"],
};

// A thumb doesn't fold perpendicular to the palm the way a finger does — it folds
// ACROSS it, toward the little finger, ending up over the closed fingers. So the
// criterion that actually distinguishes a fist from a backward bend is distance
// from the thumb tip to the middle-finger knuckle: folding in shortens it,
// hyperextending lengthens it. The palm-normal test can't tell those apart, which
// is how the current code ended up on the wrong axis.
for (const side of ["left", "right"]) {
  for (const [digit, joints] of Object.entries(CHAINS)) {
    const tipBone = `${side}${joints[joints.length - 1]}`;
    const knuckleBone = `${side}MiddleProximal`;
    console.log(`\n=== ${side} ${digit} (tip ${tipBone} vs knuckle ${knuckleBone}) ===`);
    vrm.humanoid.resetNormalizedPose();
    settle();
    const restGap = worldOf(tipBone).distanceTo(worldOf(knuckleBone));
    console.log(`  rest gap to knuckle: ${restGap.toFixed(4)}`);

    for (const axis of ["x", "y", "z"]) {
      for (const sign of [1, -1]) {
        vrm.humanoid.resetNormalizedPose();
        settle();
        const before = worldOf(tipBone);

        for (const j of joints) {
          const b = node(`${side}${j}`);
          if (!b) continue;
          const e = new THREE.Euler(0, 0, 0);
          e[axis] = sign * 1.0; // ~57 degrees per joint
          b.quaternion.setFromEuler(e);
        }
        settle();

        const moved = worldOf(tipBone).sub(before);
        const gap = worldOf(tipBone).distanceTo(worldOf(knuckleBone));
        const closes = restGap - gap;
        const mark = closes > 0.01 ? "  <== FOLDS IN" : closes < -0.01 ? "  (opens out)" : "";
        console.log(
          `  ${axis}${sign > 0 ? "+" : "-"}  gap ${gap.toFixed(4)} (closes ${closes >= 0 ? "+" : ""}${closes.toFixed(4)})` +
            `  palmward ${moved.dot(PALM).toFixed(4)}${mark}`
        );
      }
    }
  }
}

vrm.humanoid.resetNormalizedPose();
settle();
