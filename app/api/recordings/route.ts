import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getB2Client, getB2Bucket } from "@/lib/b2";

// Issues a short-lived presigned PUT URL so the browser can upload a
// finished recording directly to B2 — no video bytes ever pass through
// this (serverless) function, which sidesteps Vercel's request body size
// limits and avoids needing any server-side session state.

// Any app that uses the camera records and uploads by default, so the module
// label is validated by format (safe B2 key segment) rather than a fixed
// allowlist — new apps work without touching this route.
const MODULE_LABEL_RE = /^[a-z0-9-]{1,40}$/;
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "video/webm": "webm",
  "video/mp4": "mp4",
};
const URL_EXPIRY_SECONDS = 10 * 60; // long enough for a short scan + upload

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { module: moduleName, contentType } = (body ?? {}) as {
    module?: unknown;
    contentType?: unknown;
  };

  if (typeof moduleName !== "string" || !MODULE_LABEL_RE.test(moduleName)) {
    return NextResponse.json({ error: "unsupported module" }, { status: 400 });
  }

  const normalizedContentType =
    typeof contentType === "string" ? contentType.split(";")[0].trim() : "";
  const ext = EXT_BY_CONTENT_TYPE[normalizedContentType];
  if (!ext) {
    return NextResponse.json({ error: "unsupported content type" }, { status: 400 });
  }

  const now = new Date();
  const datePrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate()
  ).padStart(2, "0")}`;
  const key = `${moduleName}/${datePrefix}/${randomUUID()}.${ext}`;

  let uploadUrl: string;
  try {
    const client = getB2Client();
    const command = new PutObjectCommand({
      Bucket: getB2Bucket(),
      Key: key,
      ContentType: normalizedContentType,
    });
    uploadUrl = await getSignedUrl(client, command, { expiresIn: URL_EXPIRY_SECONDS });
  } catch (err) {
    console.error("failed to create presigned recording upload URL:", err);
    return NextResponse.json({ error: "failed to prepare upload" }, { status: 502 });
  }

  return NextResponse.json({ uploadUrl, key });
}
