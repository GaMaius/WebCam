const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockCtx } = require('./testUtils');
const {
  computeBlockGrid,
  drawHalftone,
  drawAscii,
  computeSobelGrid,
  computeEdgeSketchPixels,
} = require('../public/filters');

function makeImageData(pixels, width, height) {
  // pixels: array of [r,g,b] per pixel, row-major
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach(([r, g, b], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  });
  return { data, width, height };
}

test('computeBlockGrid averages a 4x4 image into 2x2 blocks', () => {
  const white = [255, 255, 255];
  const black = [0, 0, 0];
  const gray = [128, 128, 128];
  const red = [255, 0, 0];
  // rows: [white white | black black] / [white white | black black]
  //       [gray  gray  | red   red  ] / [gray  gray  | red   red  ]
  const pixels = [
    white, white, black, black,
    white, white, black, black,
    gray, gray, red, red,
    gray, gray, red, red,
  ];
  const imageData = makeImageData(pixels, 4, 4);
  const blocks = computeBlockGrid(imageData, 2);

  assert.equal(blocks.length, 4);

  const topLeft = blocks.find((b) => b.x === 0 && b.y === 0);
  assert.equal(topLeft.r, 255);
  assert.equal(topLeft.g, 255);
  assert.equal(topLeft.b, 255);
  assert.equal(topLeft.w, 2);
  assert.equal(topLeft.h, 2);

  const topRight = blocks.find((b) => b.x === 2 && b.y === 0);
  assert.equal(topRight.r, 0);
  assert.equal(topRight.brightness, 0);

  const bottomRight = blocks.find((b) => b.x === 2 && b.y === 2);
  assert.equal(bottomRight.r, 255);
  assert.equal(bottomRight.g, 0);
  assert.equal(bottomRight.b, 0);
  // luma of pure red (255,0,0) = 0.299*255 = 76.245
  assert.ok(Math.abs(bottomRight.brightness - 76.245) < 0.01);
});

test('computeBlockGrid handles image dimensions not divisible by blockSize', () => {
  const white = [255, 255, 255];
  const imageData = makeImageData([white, white, white], 3, 1);
  const blocks = computeBlockGrid(imageData, 2);
  // width 3 with blockSize 2 -> blocks at x=0 (w=2) and x=2 (w=1)
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].w, 2);
  assert.equal(blocks[1].w, 1);
});

test('drawHalftone skips zero-brightness blocks and draws a circle sized by brightness', () => {
  const ctx = createMockCtx(20, 10);
  const blocks = [
    { x: 0, y: 0, w: 10, h: 10, brightness: 0 },
    { x: 10, y: 0, w: 10, h: 10, brightness: 255 },
  ];

  drawHalftone(ctx, blocks);

  const arcCalls = ctx.calls.filter((c) => c[0] === 'arc');
  assert.equal(arcCalls.length, 1);
  const [, cx, cy, radius] = arcCalls[0];
  assert.equal(cx, 15); // block.x + w/2
  assert.equal(cy, 5); // block.y + h/2
  assert.equal(radius, 5); // (255/255) * (min(10,10)/2)
});

test('drawAscii maps brightness to charset and draws centered text', () => {
  const ctx = createMockCtx(20, 10);
  const blocks = [
    { x: 0, y: 0, w: 10, h: 10, brightness: 0 },
    { x: 10, y: 0, w: 10, h: 10, brightness: 255 },
  ];

  drawAscii(ctx, blocks);

  const textCalls = ctx.calls.filter((c) => c[0] === 'fillText');
  assert.equal(textCalls.length, 2);
  assert.equal(textCalls[0][1], ' '); // darkest -> first char in default charset
  assert.equal(textCalls[1][1], '@'); // brightest -> last char
  assert.equal(textCalls[1][2], 15); // x center
  assert.equal(textCalls[1][3], 5); // y center
});

test('computeSobelGrid finds higher edge magnitude near a vertical black/white boundary', () => {
  // 5x3 image: columns 0-1 black, columns 2-4 white
  const black = [0, 0, 0];
  const white = [255, 255, 255];
  const row = [black, black, white, white, white];
  const pixels = [...row, ...row, ...row];
  const imageData = makeImageData(pixels, 5, 3);

  const sobel = computeSobelGrid(imageData);

  const nearEdge = sobel.magnitudes[1 * 5 + 1]; // y=1, x=1 (next to boundary)
  const uniformArea = sobel.magnitudes[1 * 5 + 3]; // y=1, x=3 (inside white region)

  assert.ok(nearEdge > uniformArea);
  assert.ok(nearEdge > 100);
  assert.equal(uniformArea, 0);
});

test('computeEdgeSketchPixels renders black pixels above threshold, white otherwise', () => {
  const sobelGrid = { width: 2, height: 2, magnitudes: [300, 0, 50, 300] };
  const edgePixels = computeEdgeSketchPixels(sobelGrid, 100);

  assert.equal(edgePixels.width, 2);
  assert.equal(edgePixels.height, 2);
  // pixel 0: magnitude 300 >= 100 -> black
  assert.equal(edgePixels.data[0], 0);
  assert.equal(edgePixels.data[3], 255); // alpha
  // pixel 1: magnitude 0 -> white
  assert.equal(edgePixels.data[4], 255);
  // pixel 2: magnitude 50 < 100 -> white
  assert.equal(edgePixels.data[8], 255);
  // pixel 3: magnitude 300 -> black
  assert.equal(edgePixels.data[12], 0);
});
