import { NextResponse } from "next/server";
import {
  PICK_COUNT,
  buildUserPrompt,
  extractJson,
  normalizePicks,
  sanitizeCandidates,
  SYSTEM_PROMPT,
} from "@/lib/pokematch/judgeProtocol";

// PokéMatch's ranking judge. The browser measures the face and produces a
// visual-similarity shortlist; this route asks a Groq-hosted LLM to make the
// actual call and explain it.
//
// The model is TEXT-ONLY (openai/gpt-oss-120b), so no image is sent or
// accepted here — only the numeric descriptors the client measured and the
// candidate slugs it already has. That also means this route never handles a
// photo, and the API key never reaches the browser.
//
// Prompt construction and output parsing live in lib/pokematch/judgeProtocol
// so they can be unit-tested; this file is transport, auth and limits.

export const runtime = "nodejs";
export const maxDuration = 30;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const REQUEST_TIMEOUT_MS = 25_000;

// Best-effort abuse guard. Serverless instances are per-region and recycled,
// so this bounds a single hot instance rather than providing a global limit —
// enough to stop a tab hammering the endpoint, which is what it's for.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 12;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return recent.length > RATE_MAX_REQUESTS;
}

async function callGroq(apiKey: string, model: string, userPrompt: string, signal: AbortSignal) {
  const base = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.6,
    max_completion_tokens: 1600,
  };
  const post = (body: unknown) =>
    fetch(GROQ_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });

  // reasoning_effort / response_format are gpt-oss-specific; if the configured
  // model rejects them, fall back to a plain completion rather than failing.
  const res = await post({
    ...base,
    reasoning_effort: "low",
    response_format: { type: "json_object" },
  });
  return res.status === 400 ? post(base) : res;
}

export async function POST(request: Request) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    // Not something the user can act on — the client falls back to the local
    // ranking, so answer cheaply and let it get on with it.
    return NextResponse.json({ error: "judge_unconfigured" }, { status: 503 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { description, candidates: rawCandidates } = (body ?? {}) as {
    description?: unknown;
    candidates?: unknown;
  };

  if (typeof description !== "string" || description.trim().length < 20) {
    return NextResponse.json({ error: "missing face description" }, { status: 400 });
  }
  const candidates = sanitizeCandidates(rawCandidates);
  if (candidates.length < PICK_COUNT) {
    return NextResponse.json({ error: "not enough candidates" }, { status: 400 });
  }

  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const userPrompt = buildUserPrompt(description, candidates);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await callGroq(apiKey, model, userPrompt, controller.signal);
  } catch (err) {
    console.error("pokematch judge: groq request failed:", err);
    return NextResponse.json({ error: "judge_unavailable" }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Log the provider's message server-side only — it can echo request
    // details that don't belong in a public response.
    console.error("pokematch judge: groq responded", res.status, await res.text().catch(() => ""));
    const limited = res.status === 429;
    return NextResponse.json(
      { error: limited ? "rate_limited" : "judge_unavailable" },
      { status: limited ? 429 : 502 }
    );
  }

  const payload = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const content = payload?.choices?.[0]?.message?.content ?? "";
  const picks = normalizePicks(extractJson(content), new Set(candidates.map((c) => c.slug)));

  if (picks.length === 0) {
    console.error("pokematch judge: unusable model output:", content.slice(0, 500));
    return NextResponse.json({ error: "judge_unusable" }, { status: 502 });
  }

  return NextResponse.json({ picks, model });
}
