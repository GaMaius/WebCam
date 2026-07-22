const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../server/app');
const { createFakeS3Client } = require('./fakeS3Client');

test('GET /health returns ok status', async () => {
  const app = createApp({ s3Client: createFakeS3Client(), bucket: 'test-bucket' });
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

test('POST /session/start with wrong format is rejected', async () => {
  const app = createApp({ s3Client: createFakeS3Client(), bucket: 'test-bucket' });
  const res = await request(app).post('/session/start').send({ format: 'avi', name: 'tester' });
  assert.equal(res.status, 400);
});

test('POST /session/start creates a multipart upload and includes the name in the object key', async () => {
  const fakeClient = createFakeS3Client();
  const app = createApp({ s3Client: fakeClient, bucket: 'test-bucket' });

  const res = await request(app).post('/session/start').send({ format: 'webm', name: 'Alice Kim' });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.sessionId, 'string');

  const createCalls = fakeClient.calls.filter((c) => c.name === 'CreateMultipartUploadCommand');
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].input.Bucket, 'test-bucket');
  assert.match(createCalls[0].input.Key, /^Alice_Kim-.+\.webm$/);
});

test('POST /session/start falls back to "anonymous" when name is missing', async () => {
  const fakeClient = createFakeS3Client();
  const app = createApp({ s3Client: fakeClient, bucket: 'test-bucket' });

  await request(app).post('/session/start').send({ format: 'webm' });

  const createCalls = fakeClient.calls.filter((c) => c.name === 'CreateMultipartUploadCommand');
  assert.match(createCalls[0].input.Key, /^anonymous-.+\.webm$/);
});

test('buffers small uploads and only calls UploadPartCommand once the threshold is crossed', async () => {
  const fakeClient = createFakeS3Client();
  const app = createApp({ s3Client: fakeClient, bucket: 'test-bucket', minPartSize: 10 });

  const startRes = await request(app).post('/session/start').send({ format: 'webm', name: 'bob' });
  const { sessionId } = startRes.body;

  const upload1 = await request(app)
    .post(`/upload/${sessionId}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('12345'));
  assert.equal(upload1.status, 200);
  assert.equal(fakeClient.calls.filter((c) => c.name === 'UploadPartCommand').length, 0);

  const upload2 = await request(app)
    .post(`/upload/${sessionId}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('67890'));
  assert.equal(upload2.status, 200);

  const partCalls = fakeClient.calls.filter((c) => c.name === 'UploadPartCommand');
  assert.equal(partCalls.length, 1);
  assert.equal(partCalls[0].input.PartNumber, 1);
  assert.equal(partCalls[0].input.Body.toString(), '1234567890');
});

test('session end uploads the remaining buffer as a final part and completes the multipart upload', async () => {
  const fakeClient = createFakeS3Client();
  const app = createApp({ s3Client: fakeClient, bucket: 'test-bucket', minPartSize: 1000 });

  const startRes = await request(app).post('/session/start').send({ format: 'webm', name: 'carol' });
  const { sessionId } = startRes.body;

  await request(app)
    .post(`/upload/${sessionId}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('small-chunk'));

  const endRes = await request(app).post(`/session/end/${sessionId}`);
  assert.equal(endRes.status, 200);
  assert.deepEqual(endRes.body, { ok: true });

  const partCalls = fakeClient.calls.filter((c) => c.name === 'UploadPartCommand');
  assert.equal(partCalls.length, 1);
  assert.equal(partCalls[0].input.Body.toString(), 'small-chunk');

  const completeCalls = fakeClient.calls.filter((c) => c.name === 'CompleteMultipartUploadCommand');
  assert.equal(completeCalls.length, 1);
  assert.deepEqual(completeCalls[0].input.MultipartUpload.Parts, [
    { ETag: '"fake-etag-1"', PartNumber: 1 },
  ]);
});

test('retries a failed part upload and succeeds without duplicating the part', async () => {
  const fakeClient = createFakeS3Client();
  let uploadPartAttempts = 0;
  const originalSend = fakeClient.send.bind(fakeClient);
  fakeClient.send = async (command) => {
    if (command.constructor.name === 'UploadPartCommand') {
      uploadPartAttempts += 1;
      if (uploadPartAttempts === 1) {
        throw new Error('simulated transient failure');
      }
    }
    return originalSend(command);
  };

  const app = createApp({ s3Client: fakeClient, bucket: 'test-bucket', minPartSize: 5, retryDelayMs: 0 });
  const startRes = await request(app).post('/session/start').send({ format: 'webm', name: 'dan' });
  const { sessionId } = startRes.body;

  await request(app)
    .post(`/upload/${sessionId}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('abcdef'));

  assert.equal(uploadPartAttempts, 2);

  await request(app).post(`/session/end/${sessionId}`);

  const completeCalls = fakeClient.calls.filter((c) => c.name === 'CompleteMultipartUploadCommand');
  assert.equal(completeCalls[0].input.MultipartUpload.Parts.length, 1);
});

test('a part that fails all retries is dropped without crashing the session', async () => {
  const fakeClient = createFakeS3Client();
  fakeClient.send = async (command) => {
    if (command.constructor.name === 'CreateMultipartUploadCommand') {
      return { UploadId: 'fake-upload-1' };
    }
    if (command.constructor.name === 'UploadPartCommand') {
      throw new Error('simulated permanent failure');
    }
    if (command.constructor.name === 'CompleteMultipartUploadCommand') {
      return {};
    }
    throw new Error('unexpected command');
  };

  const app = createApp({ s3Client: fakeClient, bucket: 'test-bucket', minPartSize: 5, retryDelayMs: 0 });
  const startRes = await request(app).post('/session/start').send({ format: 'webm', name: 'eve' });
  const { sessionId } = startRes.body;

  const uploadRes = await request(app)
    .post(`/upload/${sessionId}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('abcdef'));
  assert.equal(uploadRes.status, 200);

  const endRes = await request(app).post(`/session/end/${sessionId}`);
  assert.equal(endRes.status, 200);
});

test('upload to unknown session returns 404', async () => {
  const app = createApp({ s3Client: createFakeS3Client(), bucket: 'test-bucket' });
  const res = await request(app)
    .post('/upload/does-not-exist')
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('x'));
  assert.equal(res.status, 404);
});

test('ending unknown session returns 404', async () => {
  const app = createApp({ s3Client: createFakeS3Client(), bucket: 'test-bucket' });
  const res = await request(app).post('/session/end/does-not-exist');
  assert.equal(res.status, 404);
});
