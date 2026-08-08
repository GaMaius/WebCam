// Why finger curl collapses when it's measured in normalized image space.
//
// Builds ONE finger as real metric geometry from known joint angles, then
// measures those angles back with Kalidokit's own formula out of three spaces:
//   1. the metric points themselves (HandLandmarker's worldLandmarks)
//   2. the perspective projection with an ideal depth channel
//   3. the same projection with depth flattened, which is what the normalized
//      landmarks' z actually behaves like
//
// Run: node scratch/probe_finger_space.mjs

const DEG = Math.PI / 180;

/** Kalidokit's Vector.normalizeRadians: 0 for a straight joint, 0.5 at 90 deg. */
function normalizeRadians(r) {
  if (r >= Math.PI / 2) r -= 2 * Math.PI;
  if (r <= -Math.PI / 2) {
    r += 2 * Math.PI;
    r = Math.PI - r;
  }
  return r / Math.PI;
}

/** Interior angle at `b`, in radians. */
function interior(a, b, c) {
  const v1 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const v2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const n = (v) => Math.hypot(...v);
  const dot = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (n(v1) * n(v2));
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/** Kalidokit's Vector.angleBetween3DCoords, verbatim in behavior. Folds past 90
 * degrees, which is the second bug this probe helped find: a joint flexed 120
 * degrees reports 60. */
const foldedBend = (a, b, c) => normalizeRadians(interior(a, b, c));

/** What lib/vrm/boneRig.ts jointFlexion does instead: monotonic to 180. */
const flexion = (a, b, c) => (Math.PI - interior(a, b, c)) / Math.PI;

// A finger held up in front of the camera, curling towards the viewer — the pose
// that reads as a fist. Camera at the origin looking down +Z; image y runs down,
// so "up" is -Y. Each joint flexes about +X, which rotates the segment direction
// in the Y/Z plane: straight up, then toward the camera, then back down.
function buildFinger(flexDegrees, lengths, wrist) {
  const pts = [wrist];
  let dir = [0, -1, 0];
  let angle = 0;
  for (let i = 0; i < lengths.length; i++) {
    angle += (flexDegrees[i] ?? 0) * DEG;
    dir = [0, -Math.cos(angle), -Math.sin(angle)];
    const prev = pts[pts.length - 1];
    pts.push([
      prev[0] + dir[0] * lengths[i],
      prev[1] + dir[1] * lengths[i],
      prev[2] + dir[2] * lengths[i],
    ]);
  }
  return pts;
}

// Typical webcam intrinsics for the 640x480 capture this app asks for.
const W = 640;
const H = 480;
const F = 600;

/** Metric point -> MediaPipe-style normalized landmark. */
function project(p, wristZ, depthScale) {
  return [
    (F * (p[0] / p[2]) + W / 2) / W,
    (F * (p[1] / p[2]) + H / 2) / H,
    // MediaPipe documents z as "roughly the same scale as x" and relative to the
    // wrist. depthScale models how much of that range actually survives.
    ((p[2] - wristZ) * (F / wristZ) * depthScale) / W,
  ];
}

const report = (label, pts, measure = flexion) => {
  const bends = [
    measure(pts[0], pts[1], pts[2]),
    measure(pts[1], pts[2], pts[3]),
    measure(pts[2], pts[3], pts[4]),
  ];
  console.log(
    `${label.padEnd(34)} ${bends
      .map((b) => `${(b * 180).toFixed(1).padStart(6)} deg`)
      .join("  ")}`
  );
  return bends;
};

for (const [name, flex] of [
  ["fist  (90/100/70)", [90, 100, 70]],
  ["half  (45/50/35)", [45, 50, 35]],
  ["open  (5/5/5)", [5, 5, 5]],
]) {
  console.log(`\n=== ${name} — ground truth then measured, per joint ===`);
  // Segment 0 is the palm (wrist -> knuckle); it sets the baseline direction and
  // doesn't flex, so the three flexions land on the MCP/PIP/DIP joints, which is
  // exactly what the three measurements below read.
  const metric = buildFinger([0, ...flex], [0.08, 0.045, 0.03, 0.022], [0, 0.05, 0.5]);
  const wristZ = metric[0][2];
  console.log(`${"ground truth".padEnd(34)} ${flex.map((d) => `${d.toFixed(1).padStart(6)} deg`).join("  ")}`);
  report("metric (worldLandmarks)", metric);
  report("metric, Kalidokit's folded measure", metric, foldedBend);
  for (const depthScale of [1, 0.5, 0.25, 0]) {
    report(
      `normalized, depth x${depthScale}`,
      metric.map((p) => project(p, wristZ, depthScale))
    );
  }
}
