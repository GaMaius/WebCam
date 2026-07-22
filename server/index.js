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
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

const app = createApp({ s3Client, bucket: process.env.B2_BUCKET });

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
