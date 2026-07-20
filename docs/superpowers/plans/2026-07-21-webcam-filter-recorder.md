# 실시간 웹캠 필터 + 녹화 수집 웹사이트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 웹캠 영상에 실시간 필터(하프톤 도트/ASCII/엣지 스케치)를 적용해 보여주는 반응형 웹사이트를 만들고, 동시에 원본 영상을 사용자 소유 Express 서버에 녹화 저장한다.

**Architecture:** 순수 HTML/CSS/JS(빌드 도구 없음) 프론트엔드가 `<video>`+`<canvas>`로 Canvas2D 픽셀 연산 필터를 렌더링하고, 별도로 원본 `MediaStream`을 `MediaRecorder`로 인코딩해 청크 단위로 Node.js/Express 서버에 업로드한다. 서버는 세션 ID별로 파일에 청크를 append만 하고 트랜스코딩은 하지 않는다. 필터의 순수 계산 로직(블록 평균, Sobel)과 DOM/Canvas API를 만지는 얇은 draw 함수를 분리해 계산 로직만 자동 테스트하고, 브라우저 API 오케스트레이션은 수동 검증한다.

**Tech Stack:** Node.js (내장 `node:test` 테스트 러너, `crypto.randomUUID`), Express, 순수 JS(브라우저용, 모듈 번들러 없음, UMD-lite 패턴으로 Node/브라우저 양쪽에서 로드), supertest.

## Global Constraints

- Node.js >= 18 (내장 `node:test`와 `crypto.randomUUID` 사용)
- 빌드 도구/번들러 없음 — 브라우저 JS는 일반 `<script>` 태그로 로드
- 서버는 청크를 그대로 append만 하며 트랜스코딩하지 않음
- 저장 대상은 필터 미적용 원본 웹캠 영상
- iOS Safari 호환을 위해 `video/webm`과 `video/mp4`를 런타임에 `MediaRecorder.isTypeSupported()`로 감지해 선택
- 모바일 반응형 레이아웃 필수 (터치 타깃 44px 이상, 캔버스가 화면 폭에 맞게 축소)
- 업로드 엔드포인트는 접근 코드(`ACCESS_CODE` 환경변수)로 보호

---

## File Structure

```
C:\skill_prac\
  package.json
  .gitignore
  .env.example
  server\
    app.js          # createApp({recordingsDir, accessCode}) — Express 앱 팩토리, 모든 라우트
    index.js         # 엔트리 포인트: dotenv 로드, recordings 디렉터리 생성, app.listen
  public\
    index.html       # 페이지 마크업, viewport meta, 컨트롤 UI
    style.css        # 반응형 스타일
    filters.js       # 필터 순수 계산 + draw 함수 (UMD-lite, Node/브라우저 겸용)
    recording-utils.js  # mimeType 감지, 비디오 제약조건 생성 (UMD-lite)
    main.js          # 오케스트레이션: 웹캠 시작, 카메라 전환, 렌더 루프, 녹화/업로드, wake lock
  tests\
    testUtils.js     # createMockCtx() 등 테스트 헬퍼
    filters.test.js
    recording-utils.test.js
    server.test.js
  recordings\        # 런타임 생성, gitignore 대상
```

---

### Task 1: 프로젝트 스캐폴딩 & Express 스켈레톤

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `server/app.js`
- Create: `server/index.js`
- Test: `tests/server.test.js`

**Interfaces:**
- Produces: `createApp({ recordingsDir, accessCode })` → Express `app` 인스턴스 (다른 태스크가 라우트를 추가할 때 이 팩토리를 계속 사용)

- [ ] **Step 1: git 저장소 초기화 및 npm 프로젝트 생성**

```bash
git init
npm init -y
npm install express dotenv
npm install --save-dev supertest
```

- [ ] **Step 2: `package.json`의 scripts 수정**

`package.json`에서 `"scripts"` 항목을 다음으로 교체:

```json
"scripts": {
  "start": "node server/index.js",
  "test": "node --test tests/"
}
```

- [ ] **Step 3: `.gitignore` 작성**

```
node_modules/
recordings/
.env
```

- [ ] **Step 4: `.env.example` 작성**

```
PORT=3000
ACCESS_CODE=changeme
```

- [ ] **Step 5: 실패하는 헬스체크 테스트 작성**

`tests/server.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../server/app');

test('GET /health returns ok status', async () => {
  const app = createApp({ recordingsDir: __dirname, accessCode: '' });
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});
```

- [ ] **Step 6: 테스트 실행 → 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../server/app'`

- [ ] **Step 7: `server/app.js` 최소 구현 작성**

```js
const express = require('express');
const path = require('path');

function createApp({ recordingsDir, accessCode }) {
  const app = express();

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}

module.exports = { createApp };
```

- [ ] **Step 8: `server/index.js` 작성**

```js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createApp } = require('./app');

const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
const ACCESS_CODE = process.env.ACCESS_CODE || '';

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

const app = createApp({ recordingsDir: RECORDINGS_DIR, accessCode: ACCESS_CODE });

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
```

- [ ] **Step 9: 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS — 1 test passed

- [ ] **Step 10: 커밋**

```bash
git add package.json package-lock.json .gitignore .env.example server tests
git commit -m "chore: scaffold express server with health check"
```

---

### Task 2: 서버 녹화 엔드포인트 (session/start, upload, session/end)

**Files:**
- Modify: `server/app.js`
- Test: `tests/server.test.js`

**Interfaces:**
- Consumes: `createApp({ recordingsDir, accessCode })` (Task 1)
- Produces: `POST /session/start` (body `{format:'webm'|'mp4'}`, header `x-access-code`) → `{sessionId}`; `POST /upload/:sessionId` (raw body) → `{received}`; `POST /session/end/:sessionId` → `{ok:true}`. 프론트엔드(Task 8)가 이 3개 엔드포인트를 그대로 호출한다.

- [ ] **Step 1: 실패하는 테스트 작성 — 세션 시작/업로드/종료 전체 흐름**

`tests/server.test.js`에 아래 테스트들을 추가 (기존 헬스체크 테스트는 유지):

```js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recordings-'));
}

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
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npm test`
Expected: FAIL — `/session/start` 등 라우트가 없어 404 응답, assertion 실패

- [ ] **Step 3: `server/app.js`에 세션 엔드포인트 구현**

`server/app.js` 전체를 다음으로 교체:

```js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const EXTENSION_BY_FORMAT = { webm: 'webm', mp4: 'mp4' };

function createApp({ recordingsDir, accessCode }) {
  const app = express();
  const sessions = new Map();

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.json());

  function checkAccessCode(req, res, next) {
    if (accessCode && req.header('x-access-code') !== accessCode) {
      res.status(401).json({ error: 'invalid access code' });
      return;
    }
    next();
  }

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/session/start', checkAccessCode, (req, res) => {
    const format = req.body && req.body.format;
    const ext = EXTENSION_BY_FORMAT[format];
    if (!ext) {
      res.status(400).json({ error: 'unsupported format' });
      return;
    }
    const sessionId = randomUUID();
    const filePath = path.join(recordingsDir, `${sessionId}.${ext}`);
    const stream = fs.createWriteStream(filePath);
    sessions.set(sessionId, { stream });
    res.json({ sessionId });
  });

  app.post(
    '/upload/:sessionId',
    checkAccessCode,
    express.raw({ type: '*/*', limit: '25mb' }),
    (req, res) => {
      const session = sessions.get(req.params.sessionId);
      if (!session) {
        res.status(404).json({ error: 'unknown session' });
        return;
      }
      session.stream.write(req.body);
      res.json({ received: req.body.length });
    }
  );

  app.post('/session/end/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: 'unknown session' });
      return;
    }
    session.stream.end();
    sessions.delete(req.params.sessionId);
    res.json({ ok: true });
  });

  return app;
}

module.exports = { createApp };
```

`/session/end`는 의도적으로 `checkAccessCode`를 거치지 않는다 — 탭이 그냥 닫힐 때 `navigator.sendBeacon`으로 파일을 정리하는데(Task 8), `sendBeacon`은 커스텀 헤더를 실어 보낼 수 없기 때문이다. 이 엔드포인트는 데이터를 쓰지 않고 스트림을 닫기만 하므로 접근 코드 없이 호출돼도 위험이 없다.

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS — 모든 테스트 통과 (헬스체크 포함 총 7개)

- [ ] **Step 5: 커밋**

```bash
git add server/app.js tests/server.test.js
git commit -m "feat: add session start/upload/end recording endpoints"
```

---

### Task 3: 필터 엔진 — 블록 그리드 계산 (하프톤/ASCII 공통 기반)

**Files:**
- Create: `public/filters.js`
- Test: `tests/filters.test.js`

**Interfaces:**
- Produces: `Filters.computeBlockGrid(imageData, blockSize)` → `Array<{x, y, w, h, r, g, b, brightness}>` (Task 4, 5가 소비). `imageData` 형태: `{data: Uint8ClampedArray|Array, width, height}` (RGBA, 4바이트/픽셀).

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/filters.test.js`:

```js
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
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../public/filters'`

- [ ] **Step 3: `public/filters.js` 작성 (UMD-lite, computeBlockGrid만 구현)**

```js
(function (root) {
  function computeBlockGrid(imageData, blockSize) {
    const { data, width, height } = imageData;
    const blocks = [];

    for (let by = 0; by < height; by += blockSize) {
      const h = Math.min(blockSize, height - by);
      for (let bx = 0; bx < width; bx += blockSize) {
        const w = Math.min(blockSize, width - bx);
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        const count = w * h;

        for (let y = by; y < by + h; y++) {
          for (let x = bx; x < bx + w; x++) {
            const i = (y * width + x) * 4;
            rSum += data[i];
            gSum += data[i + 1];
            bSum += data[i + 2];
          }
        }

        const r = rSum / count;
        const g = gSum / count;
        const b = bSum / count;
        const brightness = 0.299 * r + 0.587 * g + 0.114 * b;

        blocks.push({ x: bx, y: by, w, h, r, g, b, brightness });
      }
    }

    return blocks;
  }

  const api = { computeBlockGrid };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Filters = api;
  }
})(typeof window !== 'undefined' ? window : global);
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add public/filters.js tests/filters.test.js
git commit -m "feat: add computeBlockGrid pure filter function"
```

---

### Task 4: 필터 엔진 — 하프톤 도트 렌더링

**Files:**
- Modify: `public/filters.js`
- Create: `tests/testUtils.js`
- Modify: `tests/filters.test.js`

**Interfaces:**
- Consumes: `computeBlockGrid` 출력 형태 `{x, y, w, h, brightness, ...}` (Task 3)
- Produces: `Filters.drawHalftone(ctx, blockGrid)` — `main.js`(Task 8)가 halftone 필터 선택 시 호출

- [ ] **Step 1: 테스트용 mock canvas context 헬퍼 작성**

`tests/testUtils.js`:

```js
function createMockCtx(width, height) {
  const calls = [];
  return {
    canvas: { width, height },
    calls,
    fillStyle: null,
    font: null,
    textAlign: null,
    textBaseline: null,
    fillRect(...args) {
      calls.push(['fillRect', ...args]);
    },
    beginPath() {
      calls.push(['beginPath']);
    },
    arc(...args) {
      calls.push(['arc', ...args]);
    },
    fill() {
      calls.push(['fill']);
    },
    fillText(...args) {
      calls.push(['fillText', ...args]);
    },
  };
}

module.exports = { createMockCtx };
```

- [ ] **Step 2: 실패하는 테스트 작성**

`tests/filters.test.js` 상단에 추가:

```js
const { createMockCtx } = require('./testUtils');
const { computeBlockGrid, drawHalftone } = require('../public/filters');
```

(기존 `const { computeBlockGrid } = require('../public/filters');` 줄은 위 줄로 교체)

파일 하단에 테스트 추가:

```js
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
```

- [ ] **Step 3: 테스트 실행 → 실패 확인**

Run: `npm test`
Expected: FAIL — `drawHalftone is not a function`

- [ ] **Step 4: `public/filters.js`에 `drawHalftone` 추가**

`computeBlockGrid` 함수 뒤, `const api = ...` 줄 앞에 추가:

```js
  function drawHalftone(ctx, blockGrid) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#fff';

    for (const block of blockGrid) {
      const radius = (block.brightness / 255) * (Math.min(block.w, block.h) / 2);
      if (radius <= 0) continue;
      ctx.beginPath();
      ctx.arc(block.x + block.w / 2, block.y + block.h / 2, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
```

`const api = { computeBlockGrid };` 줄을 `const api = { computeBlockGrid, drawHalftone };`로 교체.

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add public/filters.js tests/filters.test.js tests/testUtils.js
git commit -m "feat: add drawHalftone filter renderer"
```

---

### Task 5: 필터 엔진 — ASCII 아트 렌더링

**Files:**
- Modify: `public/filters.js`
- Modify: `tests/filters.test.js`

**Interfaces:**
- Consumes: `computeBlockGrid` 출력 (Task 3)
- Produces: `Filters.drawAscii(ctx, blockGrid, charset?)` — 기본 charset `' .:-=+*#%@'`. `main.js`(Task 8)가 ascii 필터 선택 시 호출

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/filters.test.js` import 줄을 `const { computeBlockGrid, drawHalftone, drawAscii } = require('../public/filters');`로 교체하고 하단에 추가:

```js
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
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npm test`
Expected: FAIL — `drawAscii is not a function`

- [ ] **Step 3: `public/filters.js`에 `drawAscii` 추가**

`drawHalftone` 함수 뒤에 추가:

```js
  function drawAscii(ctx, blockGrid, charset) {
    const chars = charset || ' .:-=+*#%@';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const block of blockGrid) {
      const idx = Math.min(chars.length - 1, Math.floor((block.brightness / 255) * chars.length));
      const ch = chars[idx];
      ctx.font = `${Math.min(block.w, block.h)}px monospace`;
      ctx.fillText(ch, block.x + block.w / 2, block.y + block.h / 2);
    }
  }
```

`const api = { computeBlockGrid, drawHalftone };` 줄을 `const api = { computeBlockGrid, drawHalftone, drawAscii };`로 교체.

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add public/filters.js tests/filters.test.js
git commit -m "feat: add drawAscii filter renderer"
```

---

### Task 6: 필터 엔진 — Sobel 엣지 검출 & 스케치 렌더링

**Files:**
- Modify: `public/filters.js`
- Modify: `tests/filters.test.js`

**Interfaces:**
- Produces: `Filters.computeSobelGrid(imageData)` → `{width, height, magnitudes: number[]}`; `Filters.computeEdgeSketchPixels(sobelGrid, threshold)` → `{data: Uint8ClampedArray, width, height}` (RGBA); `Filters.drawEdgeSketch(ctx, edgePixels)` — `main.js`(Task 8)가 edge 필터 선택 시 호출

- [ ] **Step 1: 실패하는 테스트 작성 — computeSobelGrid**

`tests/filters.test.js` import 줄을 아래로 교체:

```js
const {
  computeBlockGrid,
  drawHalftone,
  drawAscii,
  computeSobelGrid,
  computeEdgeSketchPixels,
} = require('../public/filters');
```

하단에 추가:

```js
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
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npm test`
Expected: FAIL — `computeSobelGrid is not a function`

- [ ] **Step 3: `public/filters.js`에 `computeSobelGrid`, `computeEdgeSketchPixels`, `drawEdgeSketch` 추가**

`drawAscii` 함수 뒤에 추가:

```js
  function computeSobelGrid(imageData) {
    const { data, width, height } = imageData;
    const gray = new Float64Array(width * height);

    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }

    const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
    const magnitudes = new Array(width * height).fill(0);

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let sx = 0;
        let sy = 0;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const val = gray[(y + dy) * width + (x + dx)];
            sx += val * gx[k];
            sy += val * gy[k];
            k++;
          }
        }
        magnitudes[y * width + x] = Math.min(255, Math.sqrt(sx * sx + sy * sy));
      }
    }

    return { width, height, magnitudes };
  }

  function computeEdgeSketchPixels(sobelGrid, threshold) {
    const { width, height, magnitudes } = sobelGrid;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let i = 0; i < width * height; i++) {
      const v = magnitudes[i] >= threshold ? 0 : 255;
      const o = i * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }

    return { data, width, height };
  }

  function drawEdgeSketch(ctx, edgePixels) {
    const imageData = new ImageData(edgePixels.data, edgePixels.width, edgePixels.height);
    ctx.putImageData(imageData, 0, 0);
  }
```

`const api = { computeBlockGrid, drawHalftone, drawAscii };` 줄을 아래로 교체:

```js
  const api = {
    computeBlockGrid,
    drawHalftone,
    drawAscii,
    computeSobelGrid,
    computeEdgeSketchPixels,
    drawEdgeSketch,
  };
```

참고: `drawEdgeSketch`는 브라우저 전역 `ImageData` 생성자에 의존하므로 Node 테스트 대상이 아니다 (Task 8에서 브라우저로 수동 검증). `computeEdgeSketchPixels`가 실제 판정 로직을 담당하며 이건 자동 테스트된다.

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add public/filters.js tests/filters.test.js
git commit -m "feat: add sobel edge detection and edge sketch renderer"
```

---

### Task 7: 녹화 유틸 — mimeType 감지 & 비디오 제약조건 생성

**Files:**
- Create: `public/recording-utils.js`
- Create: `tests/recording-utils.test.js`

**Interfaces:**
- Produces: `RecordingUtils.pickSupportedMimeType(candidates, isSupportedFn)` → `string|null`; `RecordingUtils.buildVideoConstraints(maxWidth, facingMode)` → `MediaStreamConstraints` 형태 객체. `main.js`(Task 8)가 둘 다 소비.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/recording-utils.test.js`:

```js
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
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../public/recording-utils'`

- [ ] **Step 3: `public/recording-utils.js` 작성**

```js
(function (root) {
  function pickSupportedMimeType(candidates, isSupportedFn) {
    for (const candidate of candidates) {
      if (isSupportedFn(candidate)) return candidate;
    }
    return null;
  }

  function buildVideoConstraints(maxWidth, facingMode) {
    return {
      video: {
        width: { ideal: maxWidth },
        facingMode: facingMode || 'user',
      },
      audio: true,
    };
  }

  const api = { pickSupportedMimeType, buildVideoConstraints };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RecordingUtils = api;
  }
})(typeof window !== 'undefined' ? window : global);
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add public/recording-utils.js tests/recording-utils.test.js
git commit -m "feat: add mimeType detection and video constraints helpers"
```

---

### Task 8: 프론트엔드 페이지 — 마크업, 반응형 스타일, 오케스트레이션

**Files:**
- Create: `public/index.html`
- Create: `public/style.css`
- Create: `public/main.js`

**Interfaces:**
- Consumes: `window.Filters.{computeBlockGrid, drawHalftone, drawAscii, computeSobelGrid, computeEdgeSketchPixels, drawEdgeSketch}` (Task 3~6), `window.RecordingUtils.{pickSupportedMimeType, buildVideoConstraints}` (Task 7), 서버 엔드포인트 `POST /session/start`, `POST /upload/:sessionId`, `POST /session/end/:sessionId` (Task 2)

이 태스크는 브라우저 API(`getUserMedia`, `MediaRecorder`, `requestAnimationFrame`)에 의존하는 오케스트레이션 코드라 자동 테스트 대상이 아니다. 아래 단계는 코드 작성 + 수동 브라우저 검증으로 구성된다.

- [ ] **Step 1: `public/index.html` 작성**

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>웹캠 필터</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main>
    <div class="access-row">
      <label for="access-code">접근 코드</label>
      <input id="access-code" type="password" autocomplete="off" />
    </div>

    <p class="notice">이 화면은 촬영되어 서버에 저장됩니다.</p>

    <div class="stage">
      <video id="source-video" playsinline muted style="display:none"></video>
      <canvas id="output-canvas"></canvas>
    </div>

    <div class="controls">
      <div class="filter-buttons">
        <button data-filter="halftone" class="filter-btn active">하프톤</button>
        <button data-filter="ascii" class="filter-btn">ASCII</button>
        <button data-filter="edge" class="filter-btn">엣지 스케치</button>
      </div>

      <div class="slider-row">
        <label for="block-size">도트/블록 크기</label>
        <input id="block-size" type="range" min="2" max="40" value="10" />
      </div>

      <div class="action-row">
        <button id="start-btn">웹캠 시작</button>
        <button id="stop-btn" disabled>중지</button>
        <button id="switch-camera-btn" hidden>카메라 전환</button>
      </div>

      <p id="status-text"></p>
    </div>
  </main>

  <script src="filters.js"></script>
  <script src="recording-utils.js"></script>
  <script src="main.js"></script>
</body>
</html>
```

- [ ] **Step 2: `public/style.css` 작성 (반응형)**

```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #111;
  color: #eee;
}

main {
  max-width: 720px;
  margin: 0 auto;
  padding: 12px;
}

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

.stage {
  width: 100%;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
}

#output-canvas {
  display: block;
  width: 100%;
  height: auto;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.filter-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.filter-btn,
#start-btn,
#stop-btn,
#switch-camera-btn {
  min-height: 44px;
  min-width: 44px;
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #222;
  color: #eee;
  font-size: 1rem;
}

.filter-btn.active {
  background: #f5a623;
  color: #111;
  border-color: #f5a623;
}

.slider-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.slider-row input[type='range'] {
  height: 44px;
}

.action-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 600px) {
  .controls {
    flex-direction: column;
  }

  .filter-buttons,
  .action-row {
    flex-direction: column;
  }

  .filter-btn,
  #start-btn,
  #stop-btn,
  #switch-camera-btn {
    width: 100%;
  }
}
```

- [ ] **Step 3: `public/main.js` 작성**

```js
(function () {
  const video = document.getElementById('source-video');
  const canvas = document.getElementById('output-canvas');
  const ctx = canvas.getContext('2d');
  const accessCodeInput = document.getElementById('access-code');
  const blockSizeInput = document.getElementById('block-size');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const switchCameraBtn = document.getElementById('switch-camera-btn');
  const statusText = document.getElementById('status-text');
  const filterButtons = Array.from(document.querySelectorAll('.filter-btn'));

  let currentFilter = 'halftone';
  let facingMode = 'user';
  let stream = null;
  let mediaRecorder = null;
  let sessionId = null;
  let wakeLock = null;
  let rafId = null;

  function setStatus(text) {
    statusText.textContent = text;
  }

  function getAccessCode() {
    return accessCodeInput.value || '';
  }

  filterButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      currentFilter = btn.dataset.filter;
      filterButtons.forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  function renderFrame() {
    if (video.videoWidth === 0) {
      rafId = requestAnimationFrame(renderFrame);
      return;
    }

    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const blockSize = Number(blockSizeInput.value);

    if (currentFilter === 'halftone') {
      const blocks = window.Filters.computeBlockGrid(frame, blockSize);
      window.Filters.drawHalftone(ctx, blocks);
    } else if (currentFilter === 'ascii') {
      const blocks = window.Filters.computeBlockGrid(frame, blockSize);
      window.Filters.drawAscii(ctx, blocks);
    } else if (currentFilter === 'edge') {
      const sobel = window.Filters.computeSobelGrid(frame);
      const edgePixels = window.Filters.computeEdgeSketchPixels(sobel, 80);
      window.Filters.drawEdgeSketch(ctx, edgePixels);
    }

    rafId = requestAnimationFrame(renderFrame);
  }

  async function startRecording(mediaStream) {
    const candidates = ['video/webm;codecs=vp8,opus', 'video/mp4'];
    const mimeType = window.RecordingUtils.pickSupportedMimeType(
      candidates,
      (type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)
    );

    if (!mimeType) {
      setStatus('이 브라우저는 녹화를 지원하지 않습니다.');
      return;
    }

    const format = mimeType.includes('mp4') ? 'mp4' : 'webm';

    const startRes = await fetch('/session/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-access-code': getAccessCode(),
      },
      body: JSON.stringify({ format }),
    });

    if (!startRes.ok) {
      setStatus('세션 시작 실패: 접근 코드를 확인하세요.');
      return;
    }

    const startBody = await startRes.json();
    sessionId = startBody.sessionId;

    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size === 0) return;
      const buffer = await event.data.arrayBuffer();
      await fetch(`/upload/${sessionId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-access-code': getAccessCode(),
        },
        body: buffer,
      });
    };
    mediaRecorder.start(3000);
  }

  async function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      await new Promise((resolve) => {
        mediaRecorder.addEventListener('stop', resolve, { once: true });
        mediaRecorder.stop();
      });
    }
    if (sessionId) {
      await fetch(`/session/end/${sessionId}`, {
        method: 'POST',
        headers: { 'x-access-code': getAccessCode() },
      });
      sessionId = null;
    }
  }

  async function start() {
    const maxWidth = Math.min(window.innerWidth, 640);
    const constraints = window.RecordingUtils.buildVideoConstraints(maxWidth, facingMode);
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameraCount = devices.filter((d) => d.kind === 'videoinput').length;
    switchCameraBtn.hidden = cameraCount < 2;

    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch (err) {
        wakeLock = null;
      }
    }

    renderFrame();
    await startRecording(stream);

    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('녹화 중...');
  }

  async function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    await stopRecording();
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('중지됨');
  }

  window.addEventListener('pagehide', () => {
    if (sessionId) {
      navigator.sendBeacon(`/session/end/${sessionId}`);
    }
  });

  startBtn.addEventListener('click', () => start().catch((err) => setStatus(`오류: ${err.message}`)));
  stopBtn.addEventListener('click', () => stop().catch((err) => setStatus(`오류: ${err.message}`)));
  switchCameraBtn.addEventListener('click', async () => {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    await stop();
    await start();
  });
})();
```

- [ ] **Step 4: 로컬에서 수동 브라우저 검증**

```bash
npm start
```

브라우저에서 `http://localhost:3000` 접속 후:
1. `.env` 파일을 `.env.example` 기반으로 만들고 `ACCESS_CODE` 값을 정한 뒤 서버 재시작, 페이지의 "접근 코드" 입력란에 같은 값 입력
2. "웹캠 시작" 클릭 → 브라우저 권한 허용 → 캔버스에 하프톤 도트 화면이 실시간으로 나오는지 확인
3. ASCII, 엣지 스케치 버튼을 눌러 필터가 즉시 전환되는지 확인
4. 블록 크기 슬라이더를 최소~최대로 움직이며 도트/문자 크기가 바뀌고 버벅임이 없는지 확인
5. "중지" 클릭 후 프로젝트 루트의 `recordings/` 폴더에 `<sessionId>.webm` 파일이 생성되고, 미디어 플레이어로 정상 재생되는지 확인 (녹화 화면은 필터 없는 원본이어야 함)
6. 브라우저 개발자 도구의 디바이스 툴바로 모바일 폭(예: 390px)으로 전환해 컨트롤이 세로로 쌓이고 버튼이 잘리지 않는지 확인

- [ ] **Step 5: 커밋**

```bash
git add public/index.html public/style.css public/main.js
git commit -m "feat: add webcam filter page with recording orchestration"
```

---

### Task 9: 환경 설정, 문서화, 외부 노출 및 종단 간 수동 검증

**Files:**
- Create: `README.md`

**Interfaces:**
- 없음 (마지막 태스크, 운영 문서 + 수동 e2e 검증)

- [ ] **Step 1: `.env` 생성**

```bash
cp .env.example .env
```

`.env` 파일을 열어 `ACCESS_CODE`를 실제 사용할 코드로 수정.

- [ ] **Step 2: `README.md` 작성**

```markdown
# 웹캠 필터 + 녹화 수집

## 실행

npm install
cp .env.example .env   # ACCESS_CODE를 원하는 값으로 수정
npm start

## 외부 공개 (localtunnel)

npx localtunnel --port 3000

발급된 URL을 친구들에게 공유. 접속 후 페이지의 "접근 코드"란에 .env의 ACCESS_CODE와 동일한 값을 입력해야 녹화가 동작한다.

## 녹화 파일

원본(필터 미적용) 웹캠 영상이 세션별로 recordings/<sessionId>.webm 또는 .mp4 로 저장된다.
```

- [ ] **Step 3: `npm test`로 전체 자동 테스트 스위트 통과 확인**

Run: `npm test`
Expected: PASS — 모든 테스트(server, filters, recording-utils) 통과

- [ ] **Step 4: localtunnel로 외부 노출 후 다른 기기에서 수동 검증**

```bash
npm start
```

다른 터미널에서:

```bash
npx localtunnel --port 3000
```

1. 발급된 URL을 스마트폰(iOS Safari, Android Chrome 각각 가능하면)에서 열어 접근 코드 입력 후 웹캠 시작
2. 모바일 화면에서 레이아웃이 잘리지 않고, 전/후면 카메라 전환 버튼이 보이면 눌러서 전환되는지 확인
3. 데스크톱 브라우저 탭과 모바일을 동시에 접속시켜 두 세션이 `recordings/`에 서로 다른 파일로 저장되는지 확인
4. 잘못된 접근 코드로 시도 시 "세션 시작 실패" 메시지가 뜨는지 확인

- [ ] **Step 5: 커밋**

```bash
git add README.md .env.example
git commit -m "docs: add setup and localtunnel exposure instructions"
```
