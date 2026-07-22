const express = require('express');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const EXTENSION_BY_FORMAT = { webm: 'webm', mp4: 'mp4' };

function sanitizeName(name) {
  const trimmed = (name || '').trim();
  const cleaned = trimmed.replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
  return cleaned.slice(0, 60) || 'anonymous';
}

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
    stream.on('error', (err) => {
      console.error(`recording write error for session ${sessionId}:`, err);
    });
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
    sessions.delete(req.params.sessionId);
    session.stream.end(() => {
      res.json({ ok: true });
    });
  });

  return app;
}

module.exports = { createApp, sanitizeName };
