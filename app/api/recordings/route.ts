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

function sanitizeIp(ip: string): string {
  let clean = ip.trim();
  if (clean.startsWith("[") && clean.includes("]")) {
    clean = clean.slice(1, clean.indexOf("]"));
  } else if (clean.includes(":") && clean.split(":").length === 2 && !clean.includes("::")) {
    clean = clean.split(":")[0];
  }
  const sanitized = clean.replace(/[^a-zA-Z0-9.-]/g, "_");
  return sanitized || "unknown-ip";
}

function getClientIp(request: Request): string {
  const headers = request.headers;
  const rawIp =
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-client-ip")?.trim() ||
    headers.get("cf-connecting-ip")?.trim() ||
    "unknown-ip";

  return sanitizeIp(rawIp);
}

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

  // Human-readable key with IP folder structure:
  // <label>/<YYYY-MM-DD>/<ip>/<HHMMSS>-<label>-<shortid>.<ext>,
  // with date/time in KST so it matches the user's wall clock (not UTC).
  const clientIp = getClientIp(request);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value])
  ) as Record<string, string>;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}${parts.minute}${parts.second}`;
  const shortId = randomUUID().slice(0, 8);
  const key = `${moduleName}/${date}/${clientIp}/${time}-${moduleName}-${shortId}.${ext}`;

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
