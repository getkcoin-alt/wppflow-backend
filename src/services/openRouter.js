import { fail } from "../middleware/http.js";
import { ENV } from "../config/env.js";

// Riwo on OpenRouter's free models. The set of free models changes often, so the list is read from
// OpenRouter's public catalogue and ranked here rather than hard-coded. If a model fails, errors, is
// rate-limited upstream or returns nothing usable, the next one is tried, and a model that failed is
// left alone for a while. OpenRouter's own limits for free models are shared by the whole account (20
// requests a minute, 50 a day, or 1,000 a day once credits have been bought), and a failed request
// still counts, so those limits stop further requests instead of burning them.
const BASE = "https://openrouter.ai/api/v1";
export const FREE_ROUTER = "openrouter/free"; // OpenRouter's own pick of a free model, the last resort
const CATALOGUE_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOGUE_RETRY_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const PER_MINUTE = 18; // OpenRouter allows 20 a minute on free models; stay under it
const TIMEOUT_MS = 40_000;

const key = () => process.env.OPENROUTER_API_KEY;
export const openRouterConfigured = () => Boolean(key());
const redact = (value) => String(value ?? "").replace(/sk-or-[\w-]+/g, "sk-or-…");

// ── State and test hooks ─────────────────────────────────────────────────────────────────────────
const realFetch = (...args) => fetch(...args);
let fetcher = realFetch;
let catalogue = null; // { at, ids }
let catalogueFailedAt = 0;
let cooling = new Map(); // model -> { until, why }: when it may be used again, and why it was set aside
let pausedUntil = 0; // an account-wide limit was hit
let pausedFor = null;
let pausedStatus = 429;
let recent = []; // times of recent requests, for the per-minute ceiling
export function resetOpenRouter() {
  catalogue = null;
  catalogueFailedAt = 0;
  cooling = new Map();
  pausedUntil = 0;
  pausedFor = null;
  pausedStatus = 429;
  recent = [];
}
// Tests replace how requests are made so nothing leaves the machine.
export function setOpenRouterFetch(fn) {
  fetcher = fn || realFetch;
  resetOpenRouter();
}

// ── Choosing models ──────────────────────────────────────────────────────────────────────────────
// Best first: strong at the languages teams in the UAE and India write in (Arabic, Hindi, English),
// then bigger before smaller. A judgement about quality, not a benchmark; AI_MODELS pins an exact list.
const PREFERRED = [
  /gemma-?4/i,
  /qwen-?3.*(235b|122b|72b|32b|30b)|qwen3-next/i,
  /gpt-oss-120b/i,
  /deepseek.*v3/i,
  /llama-?3\.3-70b/i,
  /inkling(?!.*small)/i,
  /minimax/i,
  /nemotron.*(ultra|super)/i,
  /mistral.*(large|medium|small)/i,
  /deepseek/i,
];
const NOT_FOR_TEXT = /embed|moderat|guard|safeguard|tts|whisper|transcri|rerank|image|diffusion|audio|lyria/i;
const REASONING = /\br1\b|thinking|reason/i;
const sizeOf = (id) => Number(/(\d+(?:\.\d+)?)b\b/i.exec(id)?.[1]) || 0;

const pinned = () =>
  String(process.env.AI_MODELS || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

export function rankFreeModels(list) {
  const usable = (list || []).filter((m) => {
    const out = m.architecture?.output_modalities;
    const inn = m.architecture?.input_modalities;
    return (
      m.id &&
      m.id !== FREE_ROUTER &&
      !m.id.startsWith("openrouter/") &&
      Number(m.pricing?.prompt) === 0 &&
      Number(m.pricing?.completion) === 0 &&
      (!out || out.includes("text")) &&
      (!inn || inn.includes("text")) &&
      Number(m.context_length || 0) >= 4000 &&
      !NOT_FOR_TEXT.test(m.id)
    );
  });
  const score = (m) => {
    const at = PREFERRED.findIndex((re) => re.test(m.id));
    return (at === -1 ? PREFERRED.length : at) + (REASONING.test(m.id) ? 0.5 : 0);
  };
  return usable
    .sort(
      (a, b) =>
        score(a) - score(b) ||
        sizeOf(b.id) - sizeOf(a.id) ||
        Number(b.context_length || 0) - Number(a.context_length || 0) ||
        Number(b.created || 0) - Number(a.created || 0),
    )
    .map((m) => m.id);
}

async function freeModels() {
  const fixed = pinned();
  if (fixed.length) return fixed;
  const now = Date.now();
  if (catalogue && now - catalogue.at < CATALOGUE_TTL_MS) return catalogue.ids;
  if (now - catalogueFailedAt < CATALOGUE_RETRY_MS) return catalogue?.ids || [];
  try {
    const res = await fetcher(`${BASE}/models`, {
      headers: { Authorization: `Bearer ${key()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    catalogue = { at: now, ids: rankFreeModels(body.data) };
    return catalogue.ids;
  } catch (error) {
    catalogueFailedAt = now;
    console.warn("OpenRouter model list unavailable:", redact(error.message));
    return catalogue?.ids || []; // the last list we had, or none: then OpenRouter's own free router is used
  }
}

// ── Errors from OpenRouter ───────────────────────────────────────────────────────────────────────
class Rejected extends Error {
  constructor(status, message, { resetAt } = {}) {
    super(message);
    this.status = status;
    this.resetAt = resetAt;
  }
}
async function rejection(res) {
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const message = redact(body?.error?.message || res.statusText || `HTTP ${res.status}`);
  const reset = Number(res.headers?.get?.("x-ratelimit-reset") || body?.error?.metadata?.headers?.["X-RateLimit-Reset"]);
  return new Rejected(res.status, message, { resetAt: reset > 1e12 ? reset : undefined });
}

// ── Cleaning what a model writes ─────────────────────────────────────────────────────────────────
export function tidy(raw) {
  let text = String(raw ?? "")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .trim();
  // "Sure! Here's a reply:" on a line of its own
  text = text.replace(/^(?:sure|certainly|of course|here(?:'s| is| are)|okay)[^\n]{0,80}:\s*\n+/i, "").trim();
  const quoted = /^(["“”«])([\s\S]*)(["“”»])$/.exec(text);
  if (quoted && !quoted[2].includes(quoted[1]) && !/["“”]/.test(quoted[2])) text = quoted[2].trim();
  return text;
}
const contentOf = (message) =>
  Array.isArray(message?.content)
    ? message.content.map((part) => part?.text || "").join("")
    : message?.content;

// ── One request to one model ─────────────────────────────────────────────────────────────────────
async function callModel(model, system, user, maxTokens, { folded = false } = {}) {
  recent.push(Date.now());
  const messages = folded
    ? [{ role: "user", content: `${system}\n\n${user}` }]
    : [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.4,
    reasoning: { effort: "low", exclude: true },
  };
  if (process.env.AI_DATA_COLLECTION === "deny") body.provider = { data_collection: "deny" };
  let res;
  try {
    res = await fetcher(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key()}`,
        "Content-Type": "application/json",
        "HTTP-Referer": ENV.APP_URL,
        "X-Title": "Scriwo",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Rejected(0, redact(error?.message || "network error"));
  }
  if (!res.ok) throw await rejection(res);
  const data = await res.json().catch(() => ({}));
  // OpenRouter can answer 200 with an error inside when the provider behind the model failed.
  if (data.error) throw new Rejected(Number(data.error.code) || 502, redact(data.error.message || "provider error"));
  const text = tidy(contentOf(data.choices?.[0]?.message));
  if (!text) throw new Rejected(502, "empty answer");
  return {
    text,
    model: data.model || model,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

const minutes = (n) => n * 60 * 1000;
const POLICY = /data policy|privacy|training|publication/i;
const cool = (model, ms, why) => cooling.set(model, { until: Date.now() + ms, why });
const resting = (model) => (cooling.get(model)?.until || 0) > Date.now();
const PRIVACY_MESSAGE =
  "Riwo's free AI models are blocked by the privacy settings on the AI account. An administrator can allow free models there, or add credit.";

// Writes text with the best free model that works right now, falling back to the next one.
export async function askOpenRouter({ system, user, maxTokens = 1500 }) {
  const now = Date.now();
  if (now < pausedUntil) throw fail(pausedStatus, pausedFor);
  recent = recent.filter((t) => now - t < 60_000);
  if (recent.length >= PER_MINUTE) throw fail(429, "Riwo is busy right now. Please try again in a minute.");

  const ranked = (await freeModels()).filter((m) => !resting(m));
  const queue = [...ranked.slice(0, MAX_ATTEMPTS - 1), FREE_ROUTER];
  const blocked = [];
  let last;
  for (const model of queue.slice(0, MAX_ATTEMPTS)) {
    if (resting(model)) continue;
    let folded = false;
    for (;;) {
      try {
        return await callModel(model, system, user, maxTokens, { folded });
      } catch (error) {
        last = error;
        const status = error.status;
        const message = error.message || "";
        console.warn(`OpenRouter ${model} failed:`, status || "", message.slice(0, 200));
        // Some models don't accept a system message: give them the same words as part of the request.
        if (status === 400 && !folded && /system|developer|instruction/i.test(message)) {
          folded = true;
          continue;
        }
        if (status === 401 || status === 403)
          throw fail(503, "The AI assistant isn't set up correctly. Ask your administrator to check it.");
        if (status === 402) {
          pausedUntil = Date.now() + minutes(10);
          pausedFor = "Riwo's AI account needs attention. Ask your administrator to check it.";
          pausedStatus = 503;
          throw fail(503, pausedFor);
        }
        if (status === 429 && /per[- ]?day|daily|day\b/i.test(message)) {
          pausedUntil = error.resetAt && error.resetAt > Date.now() ? error.resetAt : Date.now() + minutes(60);
          pausedFor = "Riwo has used its free allowance for today. It starts again tomorrow, or an administrator can add credit to the AI account.";
          pausedStatus = 429;
          throw fail(429, pausedFor);
        }
        if (status === 429 && /per[- ]?min|minute/i.test(message)) {
          pausedUntil = Date.now() + 30_000;
          pausedFor = "Riwo is busy right now. Please try again in a minute.";
          pausedStatus = 429;
          throw fail(429, pausedFor);
        }
        if (status === 404 && POLICY.test(message)) {
          blocked.push(model);
          cool(model, minutes(10), "policy");
          // OpenRouter's own free router only picks models the account allows: if it is blocked too, none is.
          if (model === FREE_ROUTER) {
            pausedUntil = Date.now() + minutes(10);
            pausedFor = PRIVACY_MESSAGE;
            pausedStatus = 503;
          }
        } else if (status === 404) {
          cool(model, minutes(6 * 60), "gone"); // the model is gone
          catalogue = null; // read the list again
        } else cool(model, minutes(status === 429 ? 2 : status === 400 ? 10 : 5), "failed");
        break;
      }
    }
  }
  const setAsidePrivacy = [...cooling.values()].some((c) => c.why === "policy" && c.until > Date.now());
  if (blocked.length && blocked.length >= Math.min(queue.length, MAX_ATTEMPTS)) throw fail(503, PRIVACY_MESSAGE);
  if (!last) {
    // Every model is being left alone for now: say why, instead of trying them again.
    if (setAsidePrivacy) throw fail(503, PRIVACY_MESSAGE);
    throw fail(503, "Riwo is busy right now. Please try again in a minute.");
  }
  throw fail(last.status === 0 || last.status >= 500 ? 503 : 502, "Riwo couldn't finish that. Please try again in a moment.");
}
