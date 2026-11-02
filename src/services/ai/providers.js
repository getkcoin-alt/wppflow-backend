// Which AI providers this server can use, read from the environment each time so a key added on the server is picked up
// by the next request and tests can change it. Nothing about limits or model names is assumed to stay true: free tiers
// change, so every number below is only a starting point that an environment setting can replace.
//
//   GROQ_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY, MISTRAL_API_KEY, NVIDIA_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY
//   AI_SELF_BASE_URL (+ AI_SELF_API_KEY, AI_SELF_MODEL): your own GPUs, or any OpenAI-compatible server
//   AI_PROVIDERS=groq,gemini,openrouter       the order to try them in (a name with AI_<NAME>_BASE_URL is a custom provider)
//   AI_<NAME>_MODELS / _MODELS_FAST / _RPM / _DATA   per provider: models for writing, for quick jobs, requests a minute,
//                                                    and whether it keeps what it is sent (no-training | may-train | unknown)

export const POLICIES = ["no-training", "may-train", "unknown"];

const PRESETS = {
  groq: { style: "openai", baseUrl: "https://api.groq.com/openai/v1", keyEnv: ["GROQ_API_KEY"], fast: ["llama-3.1-8b-instant"], write: ["llama-3.3-70b-versatile"], policy: "no-training", rpm: 25, free: true },
  gemini: { style: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], fast: ["gemini-2.5-flash-lite", "gemini-2.5-flash"], write: ["gemini-2.5-flash"], policy: "may-train", rpm: 10, free: true },
  cerebras: { style: "openai", baseUrl: "https://api.cerebras.ai/v1", keyEnv: ["CEREBRAS_API_KEY"], fast: ["llama3.1-8b"], write: ["gpt-oss-120b", "llama-3.3-70b"], policy: "unknown", rpm: 10, free: true },
  mistral: { style: "openai", baseUrl: "https://api.mistral.ai/v1", keyEnv: ["MISTRAL_API_KEY"], fast: ["mistral-small-latest"], write: ["mistral-large-latest", "mistral-small-latest"], policy: "may-train", rpm: 30, free: true },
  nvidia: { style: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", keyEnv: ["NVIDIA_API_KEY"], fast: ["meta/llama-3.1-8b-instruct"], write: ["meta/llama-3.3-70b-instruct"], policy: "unknown", rpm: 30, free: true },
  // these two have their own clients (they are older than this file)
  openrouter: { style: "openrouter", keyEnv: ["OPENROUTER_API_KEY"], policy: "unknown", rpm: 18, free: true },
  anthropic: { style: "anthropic", keyEnv: ["ANTHROPIC_API_KEY"], policy: "no-training", rpm: 50, free: false },
};
// Tried in this order when AI_PROVIDERS is not set. Your own servers come first, Claude (paid) last.
const AUTO_ORDER = ["self", "groq", "gemini", "cerebras", "mistral", "nvidia", "openrouter", "anthropic"];

const list = (value) => String(value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const envOf = (id, suffix) => process.env[`AI_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${suffix}`];
const firstKey = (names) => names.map((n) => process.env[n]).find(Boolean) || "";

function build(id) {
  const preset = PRESETS[id];
  const custom = !preset;
  const baseUrl = String(envOf(id, "BASE_URL") || preset?.baseUrl || "").replace(/\/+$/, "");
  const key = custom ? envOf(id, "API_KEY") || "" : firstKey(preset.keyEnv);
  // a custom provider (your own GPUs) needs an address; a hosted one needs a key
  if (custom ? !baseUrl : !key) return null;
  const write = list(envOf(id, "MODELS") || envOf(id, "MODEL"));
  const fast = list(envOf(id, "MODELS_FAST"));
  const policy = POLICIES.includes(envOf(id, "DATA")) ? envOf(id, "DATA") : custom ? "no-training" : preset.policy;
  const rpm = Number(envOf(id, "RPM")) > 0 ? Number(envOf(id, "RPM")) : preset?.rpm || 60;
  return {
    id,
    style: preset?.style || "openai",
    baseUrl,
    key,
    models: { write: write.length ? write : preset?.write || [], fast: fast.length ? fast : write.length ? write : preset?.fast || preset?.write || [] },
    policy,
    rpm,
    // "free" tells people their messages may leave on a free tier; your own servers and paid Claude are not that
    free: custom ? false : preset.free,
  };
}

export function configuredProviders() {
  const forced = String(process.env.AI_PROVIDER || "").toLowerCase();
  const named = list(process.env.AI_PROVIDERS).map((x) => x.toLowerCase());
  let ids = named.length ? named : AUTO_ORDER;
  if (forced) {
    // one provider only, as before: AI_PROVIDER=anthropic keeps using Claude even when other keys exist
    const only = build(forced);
    return only ? [only] : [];
  }
  const seen = new Set();
  return ids.filter((id) => !seen.has(id) && seen.add(id)).map(build).filter(Boolean);
}

export const providerIds = () => configuredProviders().map((p) => p.id);
