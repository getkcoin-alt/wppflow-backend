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
const MAX_ATTEMPTS = 4; // the best three, then OpenRouter's own free router
const PER_MINUTE = 18; // OpenRouter allows 20 a minute on free models; stay under it
const TIMEOUT_MS = 25_000;

const key = () => process.env.OPENROUTER_API_KEY;
export const openRouterConfigured = () => Boolean(key());
const redact = (value) => String(value ?? "").replace(/sk-or-[\w-]+/g, "sk-or-…");

// ── State and test hooks ─────────────────────────────────────────────────────────────────────────
const realFetch = (...args) => fetch(...args);
let fetcher = realFetch;
let catalogue = null; // { at, ids, params: Map(id -> Set of supported parameters) }
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
  /minimax/i,
  /nemotron.*(ultra|super)/i,
  /mistral.*(large|medium|small)/i,
  /deepseek/i,
];
// Models from the same maker usually share one upstream limit, so when one is rate-limited its siblings
// are too. Spread the first tries across makers, and keep the rest in order behind them.
export function spreadAcrossMakers(ids) {
  const seen = new Set();
  const first = [];
  const rest = [];
  for (const id of ids) {
    const maker = id.split("/")[0];
    (seen.has(maker) ? rest : first).push(id);
    seen.add(maker);
  }
  return [...first, ...rest];
}
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
    const ids = rankFreeModels(body.data);
    const params = new Map(
      (body.data || []).filter((m) => Array.isArray(m.supported_parameters)).map((m) => [m.id, new Set(m.supported_parameters)]),
    );
    catalogue = { at: now, ids, params };
    return ids;
  } catch (error) {
    catalogueFailedAt = now;
    console.warn("OpenRouter model list unavailable:", redact(error.message));
    return catalogue?.ids || []; // the last list we had, or none: then OpenRouter's own free router is used
  }
}

// ── Errors from OpenRouter ───────────────────────────────────────────────────────────────────────
class Rejected extends Error {
  constructor(status, message, { resetAt, detail } = {}) {
    super(message);
    this.status = status;
    this.resetAt = resetAt;
    this.detail = detail || "";
  }
  // What a person (or a pattern) should read: OpenRouter often says only "Provider returned error" and puts
  // the real reason from the model's provider one level down.
  get text() {
    return [this.message, this.detail].filter(Boolean).join(": ");
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
  const meta = body?.error?.metadata || {};
  let detail = typeof meta.raw === "string" ? meta.raw : meta.raw ? JSON.stringify(meta.raw) : "";
  try {
    // the provider's own error is often JSON inside the string
    const inner = JSON.parse(detail);
    detail = inner?.error?.message || inner?.message || detail;
  } catch {
    /* plain text */
  }
  if (meta.provider_name) detail = `${meta.provider_name}${detail ? `: ${detail}` : ""}`;
  const reset = Number(res.headers?.get?.("x-ratelimit-reset") || meta.headers?.["X-RateLimit-Reset"]);
  return new Rejected(res.status, message, {
    resetAt: reset > 1e12 ? reset : undefined,
    detail: redact(detail).slice(0, 300),
  });
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
  const supported = catalogue?.params?.get(model); // unknown for pinned models and the free router
  const body = { model, messages, max_tokens: maxTokens };
  if (!supported || supported.has("temperature")) body.temperature = 0.4;
  // Only models that take a reasoning setting are sent one, so nobody is rejected for an unknown parameter.
  if (supported && (supported.has("reasoning") || supported.has("include_reasoning")))
    body.reasoning = { effort: "low", exclude: true };
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
  if (data.error)
    throw new Rejected(Number(data.error.code) || 502, redact(data.error.message || "provider error"), {
      detail: redact(typeof data.error.metadata?.raw === "string" ? data.error.metadata.raw : "").slice(0, 300),
    });
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

// Models that refuse a separate system message get the same words inside the request from the start.
const NO_SYSTEM_MESSAGE = /gemma/i;
const brief = (error) => redact(error.text).slice(0, 240);

// Writes text with the best free model that works right now, falling back to the next one. `trace`, when
// given, is filled with what happened on each attempt (used by the settings test).
export async function askOpenRouter({ system, user, maxTokens = 1500 }, { trace } = {}) {
  const now = Date.now();
  if (now < pausedUntil) throw fail(pausedStatus, pausedFor);
  recent = recent.filter((t) => now - t < 60_000);
  if (recent.length >= PER_MINUTE) throw fail(429, "Riwo is busy right now. Please try again in a minute.");

  const all = await freeModels();
  for (const model of all) if (resting(model)) trace?.push({ model, skipped: "set aside after an earlier failure" });
  const ranked = spreadAcrossMakers(all.filter((m) => !resting(m)));
  const queue = [...ranked.slice(0, MAX_ATTEMPTS - 1), FREE_ROUTER];
  const blocked = [];
  let last;
  for (const model of queue.slice(0, MAX_ATTEMPTS)) {
    if (resting(model)) {
      trace?.push({ model, skipped: "set aside after an earlier failure" });
      continue;
    }
    let folded = NO_SYSTEM_MESSAGE.test(model);
    for (;;) {
      const started = Date.now();
      try {
        const out = await callModel(model, system, user, maxTokens, { folded });
        trace?.push({ model, ok: true, ms: Date.now() - started, answeredBy: out.model });
        return out;
      } catch (error) {
        last = error;
        const status = error.status;
        const topLevel = error.message || ""; // OpenRouter's own words, as opposed to the provider's
        console.warn(`OpenRouter ${model} failed:`, status || "", brief(error));
        trace?.push({ model, ok: false, status, message: brief(error), ms: Date.now() - started, ...(folded ? { sentAsOneMessage: true } : {}) });
        // Some models don't accept a system message: give them the same words as part of the request.
        if (status === 400 && !folded && /system|developer|instruction/i.test(error.text)) {
          folded = true;
          continue;
        }
        // A rejected key is the account's problem. A 403 about one model ("only available on agentic harnesses",
        // flagged input) is that model's: leave it alone and try the next.
        if (status === 401 || (status === 403 && /\b(api )?key\b/i.test(topLevel)))
          throw fail(503, "The AI assistant isn't set up correctly. Ask your administrator to check it.");
        if (status === 403) {
          cool(model, minutes(6 * 60), "restricted");
          break;
        }
        if (status === 402) {
          pausedUntil = Date.now() + minutes(10);
          pausedFor = "Riwo's AI account needs attention. Ask your administrator to check it.";
          pausedStatus = 503;
          throw fail(503, pausedFor);
        }
        // OpenRouter's account-wide limits (not a provider's own quota, which is a reason to try another model)
        if (status === 429 && /free-models-per-day|per[- ]?day/i.test(topLevel)) {
          pausedUntil = error.resetAt && error.resetAt > Date.now() ? error.resetAt : Date.now() + minutes(60);
          pausedFor = "Riwo has used its free allowance for today. It starts again tomorrow, or an administrator can add credit to the AI account.";
          pausedStatus = 429;
          throw fail(429, pausedFor);
        }
        if (status === 429 && /free-models-per-min|per[- ]?min/i.test(topLevel)) {
          pausedUntil = Date.now() + 30_000;
          pausedFor = "Riwo is busy right now. Please try again in a minute.";
          pausedStatus = 429;
          throw fail(429, pausedFor);
        }
        if (status === 404 && POLICY.test(topLevel)) {
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

// What the settings test shows an administrator: the account, the models found, and every attempt.
export async function diagnoseOpenRouter() {
  // A test is how an administrator checks a fix, so it starts clean instead of waiting out an earlier pause.
  pausedUntil = 0;
  for (const [model, c] of cooling) if (c.why !== "restricted") cooling.delete(model); // a model not open to this account stays so
  const report = { provider: "openrouter", ok: false, account: null, freeModels: 0, attempts: [] };
  try {
    const res = await fetcher(`${BASE}/key`, {
      headers: { Authorization: `Bearer ${key()}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    report.account = res.ok
      ? {
          freeTier: body.data?.is_free_tier ?? null,
          used: body.data?.usage ?? null,
          limit: body.data?.limit ?? null,
        }
      : { error: redact(body?.error?.message || `HTTP ${res.status}`) };
  } catch (error) {
    report.account = { error: redact(error?.message || "network error") };
  }
  const models = await freeModels();
  report.freeModels = models.length;
  report.topModels = models.slice(0, 4);
  try {
    const out = await askOpenRouter(
      { system: "You are running a connection test.", user: "Reply with the single word OK.", maxTokens: 200 },
      { trace: report.attempts },
    );
    report.ok = true;
    report.model = out.model;
    report.sample = out.text.slice(0, 80);
  } catch (error) {
    report.error = error.message;
  }
  return report;
}
