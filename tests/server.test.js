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
