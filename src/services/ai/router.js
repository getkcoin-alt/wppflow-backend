import { fail } from "../../middleware/http.js";
import { configuredProviders } from "./providers.js";
import { askOpenAiCompat } from "./openaiCompat.js";
import { askGemini } from "./gemini.js";
import { askOpenRouter } from "../openRouter.js";

// Sends a request to the first provider that can take it, and to the next when one cannot. A provider that says "too many
// requests", rejects the key, or is down is left alone for a while; a model that no longer exists is left alone for longer.
// Nothing here knows a provider's real limits: it counts what it sends in the last minute against a setting, and listens to
// what the provider answers.

const MINUTE = 60_000;
const cooled = new Map(); // provider id -> { until, reason }
const modelCooled = new Map(); // "id|model" -> until
const windows = new Map(); // provider id -> timestamps of the last minute's requests

export function resetRouter() {
  cooled.clear();
  modelCooled.clear();
  windows.clear();
}

const used = (id, now = Date.now()) => {
  const w = (windows.get(id) || []).filter((t) => now - t < MINUTE);
  windows.set(id, w);
  return w.length;
};

function coolProvider(id, ms, reason) {
  cooled.set(id, { until: Date.now() + ms, reason });
}

// What a failure means for the provider: how long to leave it alone, or whether only the model is at fault.
function judge(error) {
  const up = error.upstream || 0;
  if (up === 401 || up === 403) return { provider: 60 * MINUTE, reason: "the key was refused" };
  if (up === 404 || up === 400 || up === 422) return { model: 6 * 60 * MINUTE };
  if (error.status === 429 || up === 429) return { provider: Math.max(10, Math.min(error.retryAfter || 60, 15 * 60)) * 1000, reason: "too many requests" };
  return { provider: 30_000, reason: error.code === "TIMEOUT" ? "too slow" : "not answering" };
}

export async function complete(request, { tier = "write", sensitivity = "customer", priority = "interactive", privateOnly = false } = {}, builtins = {}, only = null) {
  let providers = only || configuredProviders();
  if (!providers.length) throw fail(503, "The AI assistant isn't switched on for this server yet.");
  // customer messages can be held to providers that do not train on what they are sent: by the company, or for the whole server
  const strict = sensitivity === "customer" && (privateOnly || process.env.AI_REQUIRE_NO_TRAINING === "1");
  if (strict) {
    providers = providers.filter((p) => p.policy === "no-training");
    if (!providers.length) throw fail(503, "No AI provider that keeps your messages private is connected, so Riwo is paused for this company.");
  }

  let lastError = null;
  let busy = 0;
  let attempted = 0;

  // One provider, one or two models. Returns the answer, or null when it could not answer (and why is in lastError).
  const tryProvider = async (p) => {
    const now = Date.now();
    const models = p.style === "openai" || p.style === "gemini" ? (p.models[tier] || p.models.write).filter((m) => (modelCooled.get(`${p.id}|${m}`) || 0) <= now).slice(0, 2) : [null];
    if (!models.length) return null;
    for (const model of models) {
      attempted += 1;
      windows.set(p.id, [...(windows.get(p.id) || []), Date.now()]);
      try {
        let answer;
        if (p.style === "openrouter") answer = await (builtins.openrouter || askOpenRouter)(request);
        else if (p.style === "anthropic") {
          if (!builtins.anthropic) throw fail(503, "Claude is not available.");
          answer = await builtins.anthropic(request);
        } else if (p.style === "gemini") answer = await askGemini(p, model, request);
        else answer = await askOpenAiCompat(p, model, request);
        return { ...answer, provider: p.id, policy: p.policy };
      } catch (error) {
        if (error?.status === 422) throw error; // a refusal is about the content, not the provider
        lastError = error;
        const verdict = judge(error);
        if (verdict.model && model) modelCooled.set(`${p.id}|${model}`, Date.now() + verdict.model);
        else {
          coolProvider(p.id, verdict.provider || 30_000, verdict.reason || "not answering");
          console.warn(`AI provider ${p.id} set aside (${verdict.reason || "error"}): ${String(error?.detail || error?.message || "").slice(0, 160)}`);
          break;
        }
      }
    }
    return null;
  };

  const resting = [];
  for (const p of providers) {
    const now = Date.now();
    const rest = cooled.get(p.id);
    if (rest && rest.until > now) {
      resting.push(p);
      continue;
    }
    // Providers that count requests themselves (OpenRouter, Claude) keep their own limits. The others are held to a
    // setting; quick jobs nobody is waiting for give way and only use half of it.
    if (p.style === "openai" || p.style === "gemini") {
      if (used(p.id, now) >= (priority === "background" ? Math.floor(p.rpm / 2) : p.rpm)) {
        busy += 1;
        continue;
      }
    }
    const answer = await tryProvider(p);
    if (answer) return answer;
  }
  // Nothing else could be tried: a provider that is resting is better than no answer, because the rest was a guess.
  if (!attempted && resting.length) {
    for (const p of resting) {
      const answer = await tryProvider(p);
      if (answer) return answer;
    }
  }
  if (lastError) throw lastError;
  throw fail(429, "Riwo is busy right now. Please try again in a moment.");
}

// For the admin screen: who is connected, what they keep, how busy and whether one is resting. No keys.
export function routerStatus() {
  const now = Date.now();
  return configuredProviders().map((p) => {
    const rest = cooled.get(p.id);
    return {
      id: p.id,
      policy: p.policy,
      free: p.free,
      rpm: p.rpm,
      usedLastMinute: used(p.id, now),
      models: p.style === "openai" || p.style === "gemini" ? p.models : undefined,
      resting: rest && rest.until > now ? { reason: rest.reason, seconds: Math.ceil((rest.until - now) / 1000) } : null,
    };
  });
}
