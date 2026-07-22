const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3');

const EXTENSION_BY_FORMAT = { webm: 'webm', mp4: 'mp4' };

function sanitizeName(name) {
  const trimmed = (name || '').trim();
  const cleaned = trimmed.replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
  return cleaned.slice(0, 60) || 'anonymous';
}

const DEFAULT_MIN_PART_SIZE = 5 * 1024 * 1024;
const MAX_PART_ATTEMPTS = 3;
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

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

function createApp({
  s3Client,
  bucket,
  minPartSize = DEFAULT_MIN_PART_SIZE,
  retryDelayMs = 100,
  maxSessions = DEFAULT_MAX_SESSIONS,
  sessionIdleMs = DEFAULT_SESSION_IDLE_MS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
}) {
  const app = express();
  const sessions = new Map();

  function sweepIdleSessions(now = Date.now()) {
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > sessionIdleMs) {
        sessions.delete(id);
        s3Client
          .send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: session.key,
              UploadId: session.uploadId,
            })
          )
          .catch((err) => console.error(`failed to abort idle session ${id}:`, err));
      }
    }
  }

  const sweeper = setInterval(() => sweepIdleSessions(), sweepIntervalMs);
  if (sweeper.unref) sweeper.unref();
  app.locals.sweepIdleSessions = sweepIdleSessions;

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

    if (sessions.size >= maxSessions) {
      res.status(429).json({ error: 'too many active sessions' });
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
      pendingUploads: [],
      lastActivity: Date.now(),
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

      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: 'expected binary body' });
        return;
      }

      session.lastActivity = Date.now();
      session.buffer.push(req.body);
      session.bufferedBytes += req.body.length;

      if (session.bufferedBytes >= minPartSize) {
        const partBuffer = Buffer.concat(session.buffer);
        const partNumber = session.partNumber;
        session.buffer = [];
        session.bufferedBytes = 0;
        session.partNumber += 1;

        const uploadPromise = (async () => {
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
        })();
        session.pendingUploads.push(uploadPromise);
        await uploadPromise;
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

      const finalUploadPromise = (async () => {
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
      })();
      session.pendingUploads.push(finalUploadPromise);
    }

    await Promise.all(session.pendingUploads);

    if (session.uploadedParts.length === 0) {
      try {
        await s3Client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: session.key,
            UploadId: session.uploadId,
          })
        );
      } catch (err) {
        console.error(`failed to abort empty multipart upload for session ${req.params.sessionId}:`, err);
      }
      res.json({ ok: true });
      return;
    }

    session.uploadedParts.sort((a, b) => a.PartNumber - b.PartNumber);

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
