import { NextResponse } from "next/server";
import {
  PICK_COUNT,
  buildMessages,
  extractJson,
  isUsableImage,
  normalizePicks,
  sanitizeCandidates,
  summarizeRateLimit,
} from "@/lib/pokematch/judgeProtocol";

// PokéMatch's ranking judge: a Groq-hosted VISION model looks at the cropped
// face and picks from a numbered candidate list.
//
// ⚠️ This route forwards the user's face image to a third party. That is the
// whole point of the feature (the previous text-only judge never saw the
// photo), but it means the UI must say so — see app/pokematch/page.tsx. The
// crop is sent for one inference and nothing is stored here.
//
// Prompt construction and output parsing live in lib/pokematch/judgeProtocol
// so they can be unit-tested; this file is transport, auth and limits.

export const runtime = "nodejs";
export const maxDuration = 60;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Groq's vision lineup is thin: Llama 4 Scout and Maverick are both deprecated,
// leaving Qwen 3.6 27B as the multimodal option. Override with GROQ_MODEL when
// that changes — the request shape is plain OpenAI-compatible chat.
const DEFAULT_MODEL = "qwen/qwen3.6-27b";
const REQUEST_TIMEOUT_MS = 45_000;

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

async function callGroq(
  apiKey: string,
  model: string,
  messages: unknown[],
  signal: AbortSignal
) {
  // reasoning_effort "none" turns off Qwen's thinking pass. Picking five
  // lookalikes from a photo is perceptual, not deductive, so the reasoning
  // tokens bought little — and they were 300-900 of the ~3,000 tokens each
  // request costs, which matters a lot against an 8K tokens-per-minute cap.
  const base = {
    model,
    messages,
    temperature: 0.7,
    // Counted against the per-minute budget as if fully used, so it's kept
    // just above what five picks and their one-line reasons actually need
    // (~114 tokens measured) rather than left at a comfortable ceiling.
    max_completion_tokens: 300,
    reasoning_effort: "none",
  };
  const post = (body: unknown) =>
    fetch(GROQ_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });

  // Neither json_object mode nor reasoning_effort is universal across models;
  // a 400 here usually means the configured model rejected one of them, so
  // retry progressively barer rather than failing outright (extractJson copes
  // with fenced/prose-wrapped output).
  let res = await post({ ...base, response_format: { type: "json_object" } });
  if (res.status === 400) res = await post(base);
  if (res.status === 400) {
    const { reasoning_effort: _dropped, ...noReasoning } = base;
    res = await post(noReasoning);
  }
  return res;
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
    // Distinct from the upstream "rate_limited" below: this one never reached
    // Groq at all, so it means the same browser/IP hit our own per-minute cap,
    // not the provider's daily token budget.
    return NextResponse.json({ error: "rate_limited_local" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { image, description, candidates: rawCandidates } = (body ?? {}) as {
    image?: unknown;
    description?: unknown;
    candidates?: unknown;
  };

  if (!isUsableImage(image)) {
    return NextResponse.json({ error: "missing or oversized face image" }, { status: 400 });
  }
  const candidates = sanitizeCandidates(rawCandidates);
  if (candidates.length < PICK_COUNT) {
    return NextResponse.json({ error: "not enough candidates" }, { status: 400 });
  }

  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const messages = buildMessages(typeof description === "string" ? description : "", candidates, image);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await callGroq(apiKey, model, messages, controller.signal);
  } catch (err) {
    console.error("pokematch judge: groq request failed:", err);
    return NextResponse.json({ error: "judge_unavailable" }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // The full body goes to the server log only — it names the organization
    // and echoes request details that don't belong in a public response.
    console.error("pokematch judge: groq responded", res.status, raw);
    if (res.status === 429) {
      return NextResponse.json(
        {
          error: "rate_limited_upstream",
          // Sanitized: which limit tripped and how long to wait. Without this a
          // 429 can't be told apart from an exhausted daily budget, and the two
          // need opposite fixes.
          detail: summarizeRateLimit(raw, res.headers.get("retry-after")),
        },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: "judge_unavailable" }, { status: 502 });
  }

  const payload = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const content = payload?.choices?.[0]?.message?.content ?? "";
  // Picks come back as numbers into `candidates`, so the same array that built
  // the prompt has to resolve them — order matters, don't sort in between.
  const picks = normalizePicks(extractJson(content), candidates);

  if (picks.length === 0) {
    console.error("pokematch judge: unusable model output:", content.slice(0, 500));
    return NextResponse.json({ error: "judge_unusable" }, { status: 502 });
  }

  return NextResponse.json({ picks, model });
}
