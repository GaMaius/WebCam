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
