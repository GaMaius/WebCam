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
