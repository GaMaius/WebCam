const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBlockGrid } = require('../public/filters');

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
