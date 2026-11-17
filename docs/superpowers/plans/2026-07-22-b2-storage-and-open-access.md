# B2 오브젝트 스토리지 연동 & 접근 방식 변경 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 녹화 데이터를 로컬 디스크 대신 Backblaze B2에 저장하도록 서버를 바꾸고, 접근 코드를 완전히 제거해 이름 입력으로 대체하며, 촬영 안내 문구를 없앤다.

**Architecture:** `server/app.js`의 세 엔드포인트(`/session/start`, `/upload/:sessionId`, `/session/end/:sessionId`)가 로컬 파일 스트림 대신 B2의 S3 호환 API(`@aws-sdk/client-s3`)로 멀티파트 업로드를 수행한다. 3초 청크를 세션별 메모리 버퍼에 모았다가 5MB 이상이 되면 하나의 파트로 업로드하고, 세션 종료 시 남은 버퍼를 마지막 파트로 올린 뒤 업로드를 완료한다. 테스트에서는 실제 B2를 호출하지 않도록 `S3Client`를 가짜 구현으로 주입한다.

**Tech Stack:** Node.js 내장 `node:test`, Express 5, `@aws-sdk/client-s3` (Backblaze B2의 S3 호환 엔드포인트를 가리키도록 구성).

## Global Constraints

- Node.js >= 18, 빌드 도구/번들러 없음 — 브라우저 JS는 일반 `<script>` 태그로 로드
- S3 호환 멀티파트 업로드는 마지막 파트를 제외한 모든 파트가 5MB 이상이어야 함
- 로컬 디스크(`recordings/`, `RECORDINGS_DIR`)에는 더 이상 저장하지 않음 — B2가 유일한 저장소
- 접근 코드(`ACCESS_CODE`, `x-access-code` 헤더) 완전히 제거 — 이름 입력으로 대체, 이름 없이는 녹화 시작 불가
- "이 화면은 촬영되어 저장됩니다" 안내 문구 제거
- 파트 업로드 실패 시 최대 3회 재시도 후에도 실패하면 로그만 남기고 세션은 계속 진행 (크래시 금지)

---

## File Structure

```
C:\skill_prac\
  server\
    app.js       # Modify — sanitizeName 추가(Task 1), 세 엔드포인트 B2 멀티파트로 재작성(Task 2)
    index.js     # Modify — 실제 S3Client 구성(Task 3)
  public\
    index.html   # Modify — 접근 코드 제거, 이름 입력 추가, 안내 문구 제거(Task 4)
    style.css    # Modify — .access-row를 .name-row로, .notice 제거(Task 4)
    main.js      # Modify — 접근 코드 로직 제거, 이름 전송 추가(Task 4)
  tests\
    fakeS3Client.js       # Create — S3Client 가짜 구현(Task 1)
    sanitizeName.test.js  # Create (Task 1)
    server.test.js        # Modify — 전체 재작성(Task 2)
  .env.example   # Modify — B2 관련 변수로 교체(Task 3)
  .gitignore     # Modify — recordings/ 항목 제거(Task 3)
  package.json   # Modify — @aws-sdk/client-s3 의존성 추가(Task 2)
```

---

### Task 1: `sanitizeName` 순수 함수 + 테스트용 가짜 S3 클라이언트

**Files:**
- Modify: `server/app.js`
- Create: `tests/fakeS3Client.js`
- Create: `tests/sanitizeName.test.js`

**Interfaces:**
- Produces: `sanitizeName(name: string|undefined) => string` — Task 2가 이 함수를 사용해 B2 객체 키를 만든다. `createFakeS3Client()` — Task 2의 테스트가 사용하는 `S3Client` 대역, `{ calls: Array<{name, input}>, send(command) => Promise }` 형태.

- [ ] **Step 1: 실패하는 `sanitizeName` 테스트 작성**

`tests/sanitizeName.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeName } = require('../server/app');

test('sanitizeName falls back to "anonymous" for empty or missing input', () => {
  assert.equal(sanitizeName(undefined), 'anonymous');
  assert.equal(sanitizeName(''), 'anonymous');
  assert.equal(sanitizeName('   '), 'anonymous');
});

test('sanitizeName replaces spaces and slashes with underscores', () => {
  assert.equal(sanitizeName('Alice Kim'), 'Alice_Kim');
  assert.equal(sanitizeName('a/b\\c'), 'a_b_c');
});

test('sanitizeName keeps Korean characters, letters, numbers, underscore and hyphen', () => {
  assert.equal(sanitizeName('철수'), '철수');
  assert.equal(sanitizeName('user-42_test'), 'user-42_test');
});

test('sanitizeName truncates to 60 characters', () => {
  const longName = 'a'.repeat(100);
  const result = sanitizeName(longName);
  assert.equal(result.length, 60);
  assert.equal(result, 'a'.repeat(60));
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npm test`
Expected: FAIL — `sanitizeName is not a function` (또는 `undefined`), `server/app.js`에서 아직 export하지 않음

- [ ] **Step 3: `server/app.js`에 `sanitizeName` 추가**

`server/app.js` 최상단, `const EXTENSION_BY_FORMAT = { webm: 'webm', mp4: 'mp4' };` 줄 바로 다음에 추가:

```js

function sanitizeName(name) {
  const trimmed = (name || '').trim();
  const cleaned = trimmed.replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
  return cleaned.slice(0, 60) || 'anonymous';
}
```

파일 맨 아래 `module.exports = { createApp };` 줄을 다음으로 교체:

```js
module.exports = { createApp, sanitizeName };
```

(이 파일의 나머지 부분 — `createApp` 함수 본문, `checkAccessCode`, 로컬 파일 스트림 로직 — 은 Task 2에서 통째로 바뀔 예정이니 이번 단계에서는 건드리지 않는다.)

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS — 새 4개 테스트 통과, 기존 서버 테스트도 그대로 통과

- [ ] **Step 5: 가짜 S3 클라이언트 작성**

`tests/fakeS3Client.js`:

```js
function createFakeS3Client() {
  const calls = [];
  let uploadIdCounter = 0;
  let etagCounter = 0;

  return {
    calls,
    async send(command) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });

      if (name === 'CreateMultipartUploadCommand') {
        uploadIdCounter += 1;
        return { UploadId: `fake-upload-${uploadIdCounter}` };
      }
      if (name === 'UploadPartCommand') {
        etagCounter += 1;
        return { ETag: `"fake-etag-${etagCounter}"` };
      }
      if (name === 'CompleteMultipartUploadCommand') {
        return {};
      }
      throw new Error(`createFakeS3Client: unexpected command ${name}`);
    },
  };
}

module.exports = { createFakeS3Client };
```

이 파일은 아직 어디서도 `require`되지 않으므로 이 시점에는 테스트가 따로 없다 — Task 2에서 실사용된다.

- [ ] **Step 6: 전체 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS — 기존 테스트 전부 + 새 `sanitizeName` 테스트 4개, 총 20개 통과 (기존 16개 + 신규 4개)

- [ ] **Step 7: 커밋**

```bash
git add server/app.js tests/sanitizeName.test.js tests/fakeS3Client.js
git commit -m "feat: add sanitizeName helper and fake S3 client test double"
```

---

### Task 2: `server/app.js` — B2 멀티파트 업로드로 재작성

**Files:**
- Modify: `server/app.js`
- Modify: `tests/server.test.js` (전체 재작성)
- Modify: `package.json`

**Interfaces:**
- Consumes: `sanitizeName` (Task 1), `createFakeS3Client` (Task 1, 테스트에서만)
- Produces: `createApp({ s3Client, bucket, minPartSize?, retryDelayMs? })` — `s3Client`는 AWS SDK v3 `S3Client` 호환 객체(`.send(command)` 메서드 보유), `bucket`은 문자열, `minPartSize`는 기본 5MB(바이트), `retryDelayMs`는 기본 100(ms). Task 3이 실제 `S3Client`로 이 팩토리를 호출한다.
- 엔드포인트 계약은 그대로 유지: `POST /session/start` (body `{format, name}`) → `{sessionId}`; `POST /upload/:sessionId` (raw body) → `{received}`; `POST /session/end/:sessionId` → `{ok:true}`. **더 이상 `x-access-code` 헤더를 요구하지 않는다.**

- [ ] **Step 1: `@aws-sdk/client-s3` 의존성 설치**

```bash
npm install @aws-sdk/client-s3
```

- [ ] **Step 2: 실패하는 테스트로 `tests/server.test.js` 전체 재작성**

기존 `tests/server.test.js`의 모든 내용(로컬 파일/접근 코드 기반 테스트)을 삭제하고, 아래 내용으로 완전히 교체:

```js
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
```

- [ ] **Step 3: 테스트 실행 → 실패 확인**

Run: `npm test`
Expected: FAIL — `createApp`이 아직 `s3Client`/`bucket` 옵션을 모르고, 이전 시그니처(`recordingsDir`/`accessCode`)를 기대하므로 다수 테스트 실패 (예: `Cannot read properties of undefined`, 상태 코드 불일치 등)

- [ ] **Step 4: `server/app.js`를 B2 멀티파트 업로드 버전으로 전체 교체**

`server/app.js` 전체를 다음으로 교체 (Task 1에서 추가한 `sanitizeName`은 그대로 유지):

```js
const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} = require('@aws-sdk/client-s3');

const EXTENSION_BY_FORMAT = { webm: 'webm', mp4: 'mp4' };

function sanitizeName(name) {
  const trimmed = (name || '').trim();
  const cleaned = trimmed.replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
  return cleaned.slice(0, 60) || 'anonymous';
}

const DEFAULT_MIN_PART_SIZE = 5 * 1024 * 1024;
const MAX_PART_ATTEMPTS = 3;

async function uploadPartWithRetry(s3Client, params, { attempts = MAX_PART_ATTEMPTS, delayMs = 100 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await s3Client.send(new UploadPartCommand(params));
      return result.ETag;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

function createApp({ s3Client, bucket, minPartSize = DEFAULT_MIN_PART_SIZE, retryDelayMs = 100 }) {
  const app = express();
  const sessions = new Map();

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/session/start', async (req, res) => {
    const format = req.body && req.body.format;
    const ext = EXTENSION_BY_FORMAT[format];
    if (!ext) {
      res.status(400).json({ error: 'unsupported format' });
      return;
    }

    const sessionId = randomUUID();
    const key = `${sanitizeName(req.body.name)}-${sessionId}.${ext}`;

    let uploadId;
    try {
      const created = await s3Client.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })
      );
      uploadId = created.UploadId;
    } catch (err) {
      console.error('failed to start B2 multipart upload:', err);
      res.status(502).json({ error: 'failed to start upload' });
      return;
    }

    sessions.set(sessionId, {
      key,
      uploadId,
      buffer: [],
      bufferedBytes: 0,
      partNumber: 1,
      uploadedParts: [],
    });
    res.json({ sessionId });
  });

  app.post(
    '/upload/:sessionId',
    express.raw({ type: '*/*', limit: '25mb' }),
    async (req, res) => {
      const session = sessions.get(req.params.sessionId);
      if (!session) {
        res.status(404).json({ error: 'unknown session' });
        return;
      }

      session.buffer.push(req.body);
      session.bufferedBytes += req.body.length;

      if (session.bufferedBytes >= minPartSize) {
        const partBuffer = Buffer.concat(session.buffer);
        const partNumber = session.partNumber;
        session.buffer = [];
        session.bufferedBytes = 0;
        session.partNumber += 1;

        try {
          const etag = await uploadPartWithRetry(
            s3Client,
            {
              Bucket: bucket,
              Key: session.key,
              UploadId: session.uploadId,
              PartNumber: partNumber,
              Body: partBuffer,
            },
            { delayMs: retryDelayMs }
          );
          session.uploadedParts.push({ ETag: etag, PartNumber: partNumber });
        } catch (err) {
          console.error(`part ${partNumber} upload failed for session ${req.params.sessionId}:`, err);
        }
      }

      res.json({ received: req.body.length });
    }
  );

  app.post('/session/end/:sessionId', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: 'unknown session' });
      return;
    }
    sessions.delete(req.params.sessionId);

    if (session.bufferedBytes > 0) {
      const partBuffer = Buffer.concat(session.buffer);
      const partNumber = session.partNumber;

      try {
        const etag = await uploadPartWithRetry(
          s3Client,
          {
            Bucket: bucket,
            Key: session.key,
            UploadId: session.uploadId,
            PartNumber: partNumber,
            Body: partBuffer,
          },
          { delayMs: retryDelayMs }
        );
        session.uploadedParts.push({ ETag: etag, PartNumber: partNumber });
      } catch (err) {
        console.error(`final part upload failed for session ${req.params.sessionId}:`, err);
      }
    }

    try {
      await s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: session.key,
          UploadId: session.uploadId,
          MultipartUpload: { Parts: session.uploadedParts },
        })
      );
    } catch (err) {
      console.error(`failed to complete multipart upload for session ${req.params.sessionId}:`, err);
    }

    res.json({ ok: true });
  });

  return app;
}

module.exports = { createApp, sanitizeName };
```

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS — 기존 `filters.test.js`(6개) + `recording-utils.test.js`(4개) + `sanitizeName.test.js`(4개, Task 1) + 새 `server.test.js`(10개) = 총 24개 통과 (이전 로컬 파일 기반 서버 테스트 6개는 이번 교체로 사라짐)

- [ ] **Step 6: 커밋**

```bash
git add server/app.js tests/server.test.js package.json package-lock.json
git commit -m "feat: switch recording storage to Backblaze B2 multipart upload"
```

---

### Task 3: `server/index.js` — 실제 S3Client 구성 및 환경변수 정리

**Files:**
- Modify: `server/index.js`
- Modify: `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `createApp({ s3Client, bucket })` (Task 2)

이 태스크는 자동 테스트가 없다 (실제 네트워크 자격 증명을 구성하는 엔트리포인트 코드라 `node -c`로 문법만 확인). 기존 `tests/server.test.js`는 `createApp`을 직접 호출하므로 이 파일 변경에 영향받지 않는다.

- [ ] **Step 1: `server/index.js` 전체 교체**

```js
require('dotenv').config();
const { S3Client } = require('@aws-sdk/client-s3');
const { createApp } = require('./app');

const PORT = process.env.PORT || 3000;

const s3Client = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
});

const app = createApp({ s3Client, bucket: process.env.B2_BUCKET });

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
```

- [ ] **Step 2: `.env.example` 전체 교체**

```
PORT=3000
B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
B2_REGION=us-west-004
B2_BUCKET=your-bucket-name
B2_KEY_ID=your-application-key-id
B2_APPLICATION_KEY=your-application-key
```

- [ ] **Step 3: `.gitignore`에서 `recordings/` 항목 제거**

`.gitignore` 전체를 다음으로 교체:

```
node_modules/
.env
```

- [ ] **Step 4: 문법 확인**

Run: `node -c server/index.js`
Expected: 출력 없음 (문법 오류 없음)

- [ ] **Step 5: 전체 테스트 스위트 재확인 (회귀 없는지)**

Run: `npm test`
Expected: PASS — Task 2와 동일하게 24개 통과 (이 태스크는 `server/index.js`만 바꾸므로 테스트 결과에 영향 없음)

- [ ] **Step 6: 커밋**

```bash
git add server/index.js .env.example .gitignore
git commit -m "feat: wire real S3Client for B2 from environment variables"
```

---

### Task 4: 프론트엔드 — 접근 코드 제거, 이름 입력 추가, 안내 문구 제거

**Files:**
- Modify: `public/index.html`
- Modify: `public/style.css`
- Modify: `public/main.js`

**Interfaces:**
- Consumes: 서버의 `POST /session/start` (body에 이제 `{format, name}` 필요, `x-access-code` 헤더는 더 이상 필요하지 않음) — Task 2/3에서 구현됨

이 태스크도 브라우저 DOM/이벤트 코드라 자동 테스트가 없다 (`node -c`로 문법만 확인). 수동 브라우저 검증은 Task 5에서 진행한다.

- [ ] **Step 1: `public/index.html`에서 접근 코드 입력을 이름 입력으로 교체하고 안내 문구 삭제**

다음 블록을:

```html
    <div class="access-row">
      <label for="access-code">접근 코드</label>
      <input id="access-code" type="password" placeholder="접근 코드 입력 (예: changeme)" autocomplete="off" />
    </div>

    <p class="notice">이 화면은 촬영되어 서버에 저장됩니다.</p>

```

다음으로 교체:

```html
    <div class="name-row">
      <label for="user-name">이름</label>
      <input id="user-name" type="text" placeholder="이름을 입력하세요" autocomplete="off" />
    </div>

```

- [ ] **Step 2: `public/style.css`에서 `.access-row`를 `.name-row`로 바꾸고 `.notice` 삭제**

다음 블록을:

```css
.access-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}

.notice {
  font-size: 0.85rem;
  color: #f5a623;
  margin: 4px 0 12px;
}

```

다음으로 교체:

```css
.name-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}

```

- [ ] **Step 3: `public/main.js`에서 접근 코드 관련 코드를 이름 관련 코드로 교체**

`const accessCodeInput = document.getElementById('access-code');` 줄을:

```js
  const nameInput = document.getElementById('user-name');
```

로 교체.

`function getAccessCode() {\n    return accessCodeInput.value || '';\n  }` 전체를:

```js
  function getUserName() {
    return nameInput.value.trim();
  }
```

로 교체.

`startRecording` 함수 안의 `/session/start` fetch 호출을:

```js
    const startRes = await fetch('/session/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-access-code': getAccessCode(),
      },
      body: JSON.stringify({ format }),
    });

    if (startRes.status === 401) {
      throw new Error('접근 코드가 올바르지 않거나 비어 있습니다. (401 Unauthorized)');
    }
    if (!startRes.ok) {
      throw new Error(`세션 시작 실패 (상태 코드: ${startRes.status})`);
    }
```

다음으로 교체:

```js
    const startRes = await fetch('/session/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ format, name: getUserName() }),
    });

    if (!startRes.ok) {
      throw new Error(`세션 시작 실패 (상태 코드: ${startRes.status})`);
    }
```

`mediaRecorder.ondataavailable` 안의 업로드 fetch 호출에서 헤더 부분을:

```js
        await fetch(`/upload/${sessionId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-access-code': getAccessCode(),
          },
          body: buffer,
        });
```

다음으로 교체:

```js
        await fetch(`/upload/${sessionId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
          },
          body: buffer,
        });
```

`stopRecording` 안의 `/session/end` fetch 호출을:

```js
      await fetch(`/session/end/${sessionId}`, {
        method: 'POST',
        headers: { 'x-access-code': getAccessCode() },
      });
```

다음으로 교체:

```js
      await fetch(`/session/end/${sessionId}`, {
        method: 'POST',
      });
```

`start()` 함수의 맨 첫 줄(`if (busy) return;` 바로 앞)에 이름 필수 체크를 추가 — 현재:

```js
  async function start() {
    if (busy) return;
```

다음으로 교체:

```js
  async function start() {
    if (!nameInput.value.trim()) {
      setStatus('이름을 입력해주세요.');
      return;
    }
    if (busy) return;
```

- [ ] **Step 4: 문법 확인**

Run: `node -c public/main.js`
Expected: 출력 없음 (문법 오류 없음)

- [ ] **Step 5: 전체 테스트 스위트 재확인 (회귀 없는지)**

Run: `npm test`
Expected: PASS — 24개 통과 (이 태스크는 프론트엔드 파일만 바꾸므로 서버 테스트 결과에 영향 없음)

- [ ] **Step 6: 커밋**

```bash
git add public/index.html public/style.css public/main.js
git commit -m "feat: replace access code with name input and remove recording notice"
```

---

### Task 5: 수동 브라우저 검증 및 최종 확인

**Files:** 없음 (검증만)

**Interfaces:** 없음

B2 실 자격 증명이 아직 없는 상태에서도 확인 가능한 범위까지 검증한다. 실제 B2 자격 증명이 준비되면 이 태스크와 별개로 한 번 더 실제 업로드 검증이 필요하다 (이 계획의 범위 밖).

- [ ] **Step 1: 자격 증명 없이 서버가 죽지 않고 뜨는지 확인**

```bash
npm start
```

`B2_*` 환경변수가 없거나 더미 값이어도 `S3Client` 생성 자체는 실패하지 않고(자격 증명 검증은 실제 호출 시점에 일어남), 서버가 정상적으로 listen 상태가 되는지 확인.

- [ ] **Step 2: 정적 페이지 및 UI 확인**

`http://localhost:3000` 접속 후:
1. "접근 코드" 입력창이 없고 "이름" 입력창만 있는지 확인
2. "이 화면은 촬영되어 서버에 저장됩니다" 문구가 없는지 확인
3. 이름을 비운 채 "웹캠 시작" 클릭 → "이름을 입력해주세요." 상태 메시지가 뜨고 아무 것도 시작되지 않는지 확인
4. 이름을 입력하고 "웹캠 시작" 클릭 → (실제 B2 자격 증명이 없으므로) 세션 시작이 502로 실패하며 "세션 시작 실패" 계열의 오류 메시지가 뜨는지 확인 — 이때 서버 프로세스가 죽지 않고 계속 응답하는지도 확인

- [ ] **Step 3: 전체 자동 테스트 스위트 최종 확인**

Run: `npm test`
Expected: PASS — 24개 전부 통과

- [ ] **Step 4: 커밋 (검증 단계라 코드 변경 없으면 생략 가능)**

변경 사항이 없으므로 커밋할 필요 없음. 검증만 통과하면 이 태스크는 완료로 표시한다.
