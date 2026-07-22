import { S3Client } from "@aws-sdk/client-s3";

// Backblaze B2 exposes an S3-compatible API. We talk to it with the
// standard AWS SDK v3 S3 client, just pointed at B2's endpoint.
// Credentials come from environment variables only — never hardcode them.

let cachedClient: S3Client | null = null;

export function getB2Client(): S3Client {
  if (cachedClient) return cachedClient;

  const endpoint = requireEnv("B2_ENDPOINT");
  const region = requireEnv("B2_REGION");
  const accessKeyId = requireEnv("B2_KEY_ID");
  const secretAccessKey = requireEnv("B2_APPLICATION_KEY");

  cachedClient = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    // Some B2 S3-compatible endpoints reject the checksum headers the AWS
    // SDK v3 adds by default; only send them when the operation requires it.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return cachedClient;
}

export function getB2Bucket(): string {
  return requireEnv("B2_BUCKET");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name} — set it in .env.local (see .env.example).`
    );
  }
  return value;
}
