const test = require('node:test');
const assert = require('node:assert/strict');
const { pickSupportedMimeType, buildVideoConstraints } = require('../public/recording-utils');

test('pickSupportedMimeType returns first supported candidate', () => {
  const candidates = ['video/webm;codecs=vp8,opus', 'video/mp4'];
  const isSupported = (type) => type === 'video/mp4'; // simulates iOS Safari
  assert.equal(pickSupportedMimeType(candidates, isSupported), 'video/mp4');
});

test('pickSupportedMimeType returns null when nothing is supported', () => {
  const candidates = ['video/webm', 'video/mp4'];
  assert.equal(pickSupportedMimeType(candidates, () => false), null);
});

test('buildVideoConstraints uses given width and facingMode', () => {
  const constraints = buildVideoConstraints(640, 'environment');
  assert.deepEqual(constraints, {
    video: { width: { ideal: 640 }, facingMode: 'environment' },
    audio: true,
  });
});

test('buildVideoConstraints defaults facingMode to user', () => {
  const constraints = buildVideoConstraints(1280);
  assert.equal(constraints.video.facingMode, 'user');
});
