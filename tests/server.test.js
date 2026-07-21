const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../server/app');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recordings-'));
}

test('GET /health returns ok status', async () => {
  const app = createApp({ recordingsDir: __dirname, accessCode: '' });
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

test('POST /session/start without access code header is rejected when accessCode is set', async () => {
  const app = createApp({ recordingsDir: makeTempDir(), accessCode: 'secret' });
  const res = await request(app).post('/session/start').send({ format: 'webm' });
  assert.equal(res.status, 401);
});

test('POST /session/start with wrong format is rejected', async () => {
  const app = createApp({ recordingsDir: makeTempDir(), accessCode: '' });
  const res = await request(app).post('/session/start').send({ format: 'avi' });
  assert.equal(res.status, 400);
});

test('full session lifecycle writes uploaded chunks to disk in order', async () => {
  const dir = makeTempDir();
  const app = createApp({ recordingsDir: dir, accessCode: '' });

  const startRes = await request(app).post('/session/start').send({ format: 'webm' });
  assert.equal(startRes.status, 200);
  const { sessionId } = startRes.body;
  assert.equal(typeof sessionId, 'string');

  const chunk1 = Buffer.from('hello-');
  const chunk2 = Buffer.from('world');

  const upload1 = await request(app)
    .post(`/upload/${sessionId}`)
    .set('Content-Type', 'application/octet-stream')
    .send(chunk1);
  assert.equal(upload1.status, 200);
  assert.equal(upload1.body.received, chunk1.length);

  const upload2 = await request(app)
    .post(`/upload/${sessionId}`)
    .set('Content-Type', 'application/octet-stream')
    .send(chunk2);
  assert.equal(upload2.status, 200);

  const endRes = await request(app).post(`/session/end/${sessionId}`);
  assert.equal(endRes.status, 200);
  assert.deepEqual(endRes.body, { ok: true });

  const filePath = path.join(dir, `${sessionId}.webm`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const fileContents = fs.readFileSync(filePath);
  assert.equal(fileContents.toString(), 'hello-world');
});

test('upload to unknown session returns 404', async () => {
  const app = createApp({ recordingsDir: makeTempDir(), accessCode: '' });
  const res = await request(app)
    .post('/upload/does-not-exist')
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('x'));
  assert.equal(res.status, 404);
});

test('ending unknown session returns 404', async () => {
  const app = createApp({ recordingsDir: makeTempDir(), accessCode: '' });
  const res = await request(app).post('/session/end/does-not-exist');
  assert.equal(res.status, 404);
});
