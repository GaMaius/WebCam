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

// TWO PROVIDERS, TRIED IN ORDER.
//
// Any OpenAI-compatible chat-completions endpoint works — the request is a
// plain `messages` array with an `image_url` part, which OpenAI, OpenRouter,
// Together and Groq all accept unchanged. So the secondary is not a clone of
// the primary: it is there to be a DIFFERENT provider, which is what makes it
// useful. A rate limit, an outage or a model deprecation on one is exactly the
// situation where the other still answers, and those have each happened here.
//
// Environment variables (secondary is entirely optional):
//   JUDGE_API_KEY    / JUDGE_API_URL    / JUDGE_MODEL      <- primary
//   JUDGE_API_KEY_2  / JUDGE_API_URL_2  / JUDGE_MODEL_2    <- fallback
// GROQ_API_KEY and GROQ_MODEL still work as the primary, so existing
// deployments keep running untouched.
const DEFAULT_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// Groq's vision lineup is thin: Llama 4 Scout and Maverick are both deprecated,
// leaving Qwen 3.6 27B as the multimodal option.
const DEFAULT_MODEL = "qwen/qwen3.6-27b";

interface Provider {
  label: string;
  url: string;
  key: string;
  model: string;
}

/** Configured providers in priority order. Missing keys are skipped rather
 * than erroring, so adding a second one is purely additive. */
function providers(): Provider[] {
  const out: Provider[] = [];
  const primaryKey = process.env.JUDGE_API_KEY || process.env.GROQ_API_KEY;
  if (primaryKey) {
    out.push({
      label: "primary",
      url: process.env.JUDGE_API_URL || DEFAULT_API_URL,
      key: primaryKey,
      model: process.env.JUDGE_MODEL || process.env.GROQ_MODEL || DEFAULT_MODEL,
    });
  }
  if (process.env.JUDGE_API_KEY_2) {
    out.push({
      label: "secondary",
      url: process.env.JUDGE_API_URL_2 || DEFAULT_API_URL,
      key: process.env.JUDGE_API_KEY_2,
      model: process.env.JUDGE_MODEL_2 || DEFAULT_MODEL,
    });
  }
  return out;
}

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

async function callProvider(
  provider: Provider,
  messages: unknown[],
  signal: AbortSignal
) {
  // reasoning_effort "none" turns off Qwen's thinking pass. Picking five
  // lookalikes from a photo is perceptual, not deductive, so the reasoning
  // tokens bought little — and they were 300-900 of the ~3,000 tokens each
  // request costs, which matters a lot against an 8K tokens-per-minute cap.
  const base = {
    model: provider.model,
    messages,
    // ⚠️ HIGH ON PURPOSE. 0.15 was tried, to stop the answer changing between
    // scans, and it made the app worse: the model collapsed onto its argmax,
    // which for every face is a famous safe mascot (Psyduck, Pikachu) with a
    // reason vague enough to fit anyone.
    //
    // This model's RANKING is the weak part, not its knowledge — species the
    // user recognised as genuinely resembling them (Riolu, Zorua, Zoroark) are
    // inside its distribution but are never its top choice. Sampling is the
    // only way to reach them. The cost is honest: some scans miss. For a
    // for-fun app, occasionally excellent beats reliably bland, and re-rolling
    // is cheap now that requests no longer blow the per-minute cap.
    temperature: 0.7,
    // Counted against the per-minute budget as if fully used, so it's kept
    // just above what five picks and their one-line reasons actually need
    // (~114 tokens measured) rather than left at a comfortable ceiling.
    max_completion_tokens: 300,
    reasoning_effort: "none",
  };
  const post = (body: unknown) =>
    fetch(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.key}` },
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


/** One provider's full attempt: call, parse, validate. Returns picks on
 * success, or a reason the caller can fall back on. */
async function attempt(
  provider: Provider,
  messages: unknown[],
  candidates: ReturnType<typeof sanitizeCandidates>
): Promise<
  | { ok: true; picks: ReturnType<typeof normalizePicks>; model: string }
  | { ok: false; status: number; error: string; detail?: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await callProvider(provider, messages, controller.signal);
  } catch (err) {
    console.error(`pokematch judge: ${provider.label} request failed:`, err);
    return { ok: false, status: 502, error: "judge_unavailable" };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // The full body goes to the server log only — it names the organization
    // and echoes request details that don't belong in a public response.
    console.error(`pokematch judge: ${provider.label} responded`, res.status, raw);
    if (res.status === 429) {
      return {
        ok: false,
        status: 429,
        error: "rate_limited_upstream",
        // Sanitized: which limit tripped and how long to wait. Without this a
        // 429 can't be told apart from an exhausted daily budget, and the two
        // need opposite fixes.
        detail: summarizeRateLimit(raw, res.headers.get("retry-after")),
      };
    }
    return { ok: false, status: 502, error: "judge_unavailable" };
  }

  const payload = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const content = payload?.choices?.[0]?.message?.content ?? "";
  // Picks come back as numbers into `candidates`, so the same array that built
  // the prompt has to resolve them — order matters, don't sort in between.
  const picks = normalizePicks(extractJson(content), candidates);

  if (picks.length === 0) {
    console.error(
      `pokematch judge: ${provider.label} unusable output:`,
      content.slice(0, 500)
    );
    // Counts as a failure worth failing over on: a model that answered but
    // answered unusably is exactly what a second provider is for.
    return { ok: false, status: 502, error: "judge_unusable" };
  }
  return { ok: true, picks, model: provider.model };
}

export async function POST(request: Request) {
  const configured = providers();
  if (configured.length === 0) {
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
    // a provider at all, so it means the same browser/IP hit our own
    // per-minute cap, not a provider's token budget.
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

  const messages = buildMessages(
    typeof description === "string" ? description : "",
    candidates,
    image
  );

  // Try each configured provider in turn. Only the LAST failure is reported,
  // because that is the state the user is actually in — if the primary was
  // rate limited but the secondary answered, nothing went wrong from here.
  let last: { status: number; error: string; detail?: string } | null = null;
  for (const provider of configured) {
    const result = await attempt(provider, messages, candidates);
    if (result.ok) {
      return NextResponse.json({
        picks: result.picks,
        model: result.model,
        // Which provider answered, so ?debug can show a silent failover.
        provider: provider.label,
      });
    }
    last = { status: result.status, error: result.error, detail: result.detail };
    if (configured.length > 1) {
      console.warn(
        `pokematch judge: ${provider.label} failed (${result.error}), trying next`
      );
    }
  }

  return NextResponse.json(
    { error: last?.error ?? "judge_unavailable", detail: last?.detail },
    { status: last?.status ?? 502 }
  );
}
