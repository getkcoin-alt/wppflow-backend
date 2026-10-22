import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { setAiClient } from "../src/services/aiService.js";
import {
  askOpenRouter,
  rankFreeModels,
  resetOpenRouter,
  setOpenRouterFetch,
  tidy,
  FREE_ROUTER,
} from "../src/services/openRouter.js";
import { closeSessions } from "../src/services/sessionService.js";

const KEY = "sk-or-v1-0123456789abcdef-test";
const ENVS = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "AI_PROVIDER", "AI_MODELS", "AI_DATA_COLLECTION"];
const model = (id, over = {}) => ({
  id,
  context_length: 32000,
  created: 1,
  pricing: { prompt: "0", completion: "0" },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  ...over,
});
const CATALOGUE = [
  model("anthropic/claude-paid", { pricing: { prompt: "0.000003", completion: "0.000015" } }),
  model("some/small-7b:free"),
  model("deepseek/deepseek-r1:free"),
  model("nvidia/nemotron-3-ultra-550b-a55b:free"),
  model("meta-llama/llama-3.3-70b-instruct:free"),
  model("openai/gpt-oss-120b:free"),
  model("google/gemma-4-31b-it:free", { context_length: 262144 }),
  model("openrouter/free"),
  model("maker/image-maker:free", { architecture: { input_modalities: ["text"], output_modalities: ["image"] } }),
  model("maker/text-embed:free"),
  model("tiny/context:free", { context_length: 2000 }),
];
const RANKED = [
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-120b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "deepseek/deepseek-r1:free",
  "some/small-7b:free",
];

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const answer = (text, over = {}) =>
  json({ model: over.model, choices: [{ message: { content: text } }], usage: { prompt_tokens: 210, completion_tokens: 40 } });
const rejected = (status, message, headers) => json({ error: { code: status, message } }, status, headers);

// A stand-in for OpenRouter: it serves the model list and answers each model as scripted.
function fakeOpenRouter({ catalogue = CATALOGUE, models = {} } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), init, body });
    if (String(url).endsWith("/models")) {
      if (catalogue instanceof Error) throw catalogue;
      return catalogue === 500 ? rejected(500, "down") : json({ data: catalogue });
    }
    const script = models[body.model];
    const step = Array.isArray(script) ? (script.length > 1 ? script.shift() : script[0]) : script;
    if (typeof step === "function") return step(body);
    return step ? step.clone() : answer(`Hello from ${body.model}`, { model: body.model });
  };
  const chats = () => calls.filter((c) => c.url.endsWith("/chat/completions"));
  return { calls, fetcher, chats, tried: () => chats().map((c) => c.body.model) };
}
const ask = (extra = {}) => askOpenRouter({ system: "You are Riwo.", user: "Write a reply.", ...extra });

test("OpenRouter's free models: choosing, falling back, and respecting its limits", async (t) => {
  const saved = Object.fromEntries(ENVS.map((k) => [k, process.env[k]]));
  const warn = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args.join(" "));
  t.beforeEach(() => {
    for (const k of ENVS) delete process.env[k];
    process.env.OPENROUTER_API_KEY = KEY;
    resetOpenRouter();
  });
  t.after(() => {
    console.warn = warn;
    setOpenRouterFetch(undefined);
    for (const k of ENVS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  });
  const use = (opts) => {
    const fake = fakeOpenRouter(opts);
    setOpenRouterFetch(fake.fetcher);
    return fake;
  };

  await t.test("ranks the free text models by strength in Arabic, Hindi and English, then size", () => {
    assert.deepEqual(rankFreeModels(CATALOGUE), RANKED);
    const out = rankFreeModels(CATALOGUE);
    for (const left of ["anthropic/claude-paid", "openrouter/free", "maker/image-maker:free", "maker/text-embed:free", "tiny/context:free"])
      assert.ok(!out.includes(left), `${left} is not a free text model`);
  });

  await t.test("asks the best free model, with the key and the app's name, and reads its answer", async () => {
    const fake = use();
    const out = await ask();
    assert.equal(out.text, "Hello from google/gemma-4-31b-it:free");
    assert.equal(out.model, "google/gemma-4-31b-it:free");
    assert.deepEqual(out.usage, { input_tokens: 210, output_tokens: 40 });
    const [list, chat] = fake.calls;
    assert.equal(list.url, "https://openrouter.ai/api/v1/models");
    assert.equal(chat.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(chat.init.method, "POST");
    assert.equal(chat.init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(chat.init.headers["X-Title"], "Scriwo");
    assert.ok(chat.init.headers["HTTP-Referer"]);
    assert.equal(chat.body.model, "google/gemma-4-31b-it:free");
    assert.deepEqual(chat.body.messages.map((m) => m.role), ["system", "user"]);
    assert.equal(chat.body.provider, undefined, "the account's own privacy settings decide by default");
    assert.ok(chat.body.max_tokens > 0);
  });

  await t.test("reads the model list once, not on every request", async () => {
    const fake = use();
    await ask();
    await ask();
    assert.equal(fake.calls.filter((c) => c.url.endsWith("/models")).length, 1);
  });

  await t.test("moves to the next model when one fails, and leaves the failed one alone for a while", async () => {
    const fake = use({ models: { "google/gemma-4-31b-it:free": rejected(502, "Provider returned error") } });
    const first = await ask();
    assert.equal(first.text, "Hello from openai/gpt-oss-120b:free");
    assert.deepEqual(fake.tried(), ["google/gemma-4-31b-it:free", "openai/gpt-oss-120b:free"]);
    await ask();
    assert.deepEqual(fake.tried().slice(2), ["openai/gpt-oss-120b:free"], "the failed model is skipped next time");
  });

  await t.test("a model that is rate-limited upstream is set aside, and the next one is used", async () => {
    const fake = use({ models: { "google/gemma-4-31b-it:free": rejected(429, "google/gemma-4-31b-it:free is temporarily rate-limited upstream") } });
    assert.equal((await ask()).model, "openai/gpt-oss-120b:free");
    assert.equal(fake.tried().length, 2);
  });

  await t.test("empty answers and reasoning with no answer count as failures", async () => {
    const empty = json({ choices: [{ message: { content: "", reasoning: "thinking out loud…" } }] });
    const fake = use({ models: { "google/gemma-4-31b-it:free": empty, "openai/gpt-oss-120b:free": answer("   ") } });
    const out = await ask();
    assert.equal(out.model, FREE_ROUTER);
    assert.equal(fake.tried().length, 3);
  });

  await t.test("falls back to OpenRouter's own free router as the last resort", async () => {
    const fake = use({
      models: {
        "google/gemma-4-31b-it:free": rejected(503, "busy"),
        "openai/gpt-oss-120b:free": rejected(503, "busy"),
      },
    });
    const out = await ask();
    assert.deepEqual(fake.tried(), ["google/gemma-4-31b-it:free", "openai/gpt-oss-120b:free", FREE_ROUTER]);
    assert.equal(out.model, FREE_ROUTER);
  });

  await t.test("gives up after three tries with a plain message", async () => {
    const fake = use({ models: { "google/gemma-4-31b-it:free": rejected(503, "x"), "openai/gpt-oss-120b:free": rejected(503, "x"), [FREE_ROUTER]: rejected(503, "x") } });
    await assert.rejects(ask(), (e) => e.status === 503 && /couldn't finish that/.test(e.message));
    assert.equal(fake.tried().length, 3);
  });

  await t.test("tidies what models write: reasoning tags, a lead-in line and wrapping quotes", () => {
    assert.equal(tidy("<think>let me see</think>\nHello there"), "Hello there");
    assert.equal(tidy("Sure! Here's a reply:\n\nHi Asha, it's available."), "Hi Asha, it's available.");
    assert.equal(tidy('"Hi Asha, see you tomorrow."'), "Hi Asha, see you tomorrow.");
    assert.equal(tidy('He said "yes" and "no"'), 'He said "yes" and "no"');
    assert.equal(tidy("مرحبا بك"), "مرحبا بك");
  });

  await t.test("a model that refuses a system message gets the same words inside the request", async () => {
    const fake = use({
      models: {
        "google/gemma-4-31b-it:free": [
          (body) => (body.messages.some((m) => m.role === "system") ? rejected(400, "Developer instruction is not enabled for this model") : answer("Folded OK", { model: body.model })),
        ],
      },
    });
    const out = await ask();
    assert.equal(out.text, "Folded OK");
    const sent = fake.chats();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].body.messages.map((m) => m.role), ["user"]);
    assert.match(sent[1].body.messages[0].content, /You are Riwo\.[\s\S]*Write a reply\./);
    assert.equal(sent[1].body.model, sent[0].body.model, "same model, not a fallback");
  });

  await t.test("the free daily limit stops further requests instead of burning them", async () => {
    const reset = Date.now() + 120;
    const fake = use({ models: { "google/gemma-4-31b-it:free": rejected(429, "Rate limit exceeded: free-models-per-day", { "x-ratelimit-reset": String(reset) }) } });
    await assert.rejects(ask(), (e) => e.status === 429 && /free allowance for today/.test(e.message));
    assert.equal(fake.chats().length, 1, "no other model was tried: the limit is shared by all free models");
    await assert.rejects(ask(), (e) => e.status === 429);
    assert.equal(fake.chats().length, 1, "and nothing is sent while the limit holds");
    await new Promise((r) => setTimeout(r, 160));
    fake.calls.length = 0;
    // the limit has reset: requests go out again
    const out = await ask().catch((e) => e);
    assert.ok(fake.chats().length >= 1, `asked again after the reset (${out.message || "ok"})`);
  });

  await t.test("the per-minute limit pauses briefly, also without trying other models", async () => {
    const fake = use({ models: { "google/gemma-4-31b-it:free": rejected(429, "Rate limit exceeded: free-models-per-min") } });
    await assert.rejects(ask(), (e) => e.status === 429 && /busy right now/.test(e.message));
    await assert.rejects(ask(), (e) => e.status === 429);
    assert.equal(fake.chats().length, 1);
  });

  await t.test("stays under OpenRouter's 20 a minute by itself", async () => {
    const fake = use();
    for (let i = 0; i < 18; i++) await ask();
    await assert.rejects(ask(), (e) => e.status === 429 && /busy right now/.test(e.message));
    assert.equal(fake.chats().length, 18);
  });

  await t.test("a refused key is reported as a setup problem and is not retried on other models", async () => {
    const fake = use({ models: { "google/gemma-4-31b-it:free": rejected(401, `No auth credentials found ${KEY}`) } });
    await assert.rejects(ask(), (e) => e.status === 503 && /isn't set up correctly/.test(e.message) && !e.message.includes(KEY));
    assert.equal(fake.chats().length, 1);
    assert.ok(logged.every((line) => !line.includes(KEY)), "the key never reaches the log");
  });

  await t.test("an account that owes money is paused and reported", async () => {
    const fake = use({ models: { "google/gemma-4-31b-it:free": rejected(402, "Insufficient credits") } });
    await assert.rejects(ask(), (e) => e.status === 503 && /account needs attention/.test(e.message));
    await assert.rejects(ask(), (e) => e.status === 503);
    assert.equal(fake.chats().length, 1);
  });

  await t.test("when the account's privacy settings block every free model, it says so plainly", async () => {
    const blocked = rejected(404, "No endpoints found matching your data policy (Free model training)");
    const fake = use({ models: { "google/gemma-4-31b-it:free": blocked, "openai/gpt-oss-120b:free": blocked, [FREE_ROUTER]: blocked } });
    await assert.rejects(ask(), (e) => e.status === 503 && /privacy settings on the AI account/.test(e.message));
    assert.equal(fake.chats().length, 3);
    await assert.rejects(ask(), (e) => /privacy settings/.test(e.message));
    assert.equal(fake.chats().length, 3, "and it does not keep trying while they are set aside");
  });

  await t.test("a model that no longer exists is dropped and the list is read again", async () => {
    const fake = use({ models: { "google/gemma-4-31b-it:free": rejected(404, "No endpoints found for google/gemma-4-31b-it:free.") } });
    assert.equal((await ask()).model, "openai/gpt-oss-120b:free");
    await ask();
    assert.equal(fake.calls.filter((c) => c.url.endsWith("/models")).length, 2);
  });

  await t.test("if the model list can't be read, OpenRouter's free router still answers", async () => {
    const fake = use({ catalogue: 500 });
    const out = await ask();
    assert.equal(out.model, FREE_ROUTER);
    await ask();
    assert.equal(fake.calls.filter((c) => c.url.endsWith("/models")).length, 1, "it doesn't hammer the list while it is down");
  });

  await t.test("a pinned list of models (AI_MODELS) is used as written, with no list to read", async () => {
    process.env.AI_MODELS = " vendor/first:free , vendor/second:free,vendor/third:free ";
    const fake = use({ models: { "vendor/first:free": rejected(503, "x") } });
    const out = await ask();
    assert.equal(out.model, "vendor/second:free");
    assert.equal(fake.calls.filter((c) => c.url.endsWith("/models")).length, 0);
  });

  await t.test("can be told to use only providers that keep no data", async () => {
    process.env.AI_DATA_COLLECTION = "deny";
    const fake = use();
    await ask();
    assert.deepEqual(fake.chats()[0].body.provider, { data_collection: "deny" });
  });
});

test("Riwo uses OpenRouter when its key is set, and Claude only when asked", async (t) => {
  const saved = Object.fromEntries(ENVS.map((k) => [k, process.env[k]]));
  const warn = console.warn;
  console.warn = () => {};
  for (const k of ENVS) delete process.env[k];
  const fake = fakeOpenRouter();
  setOpenRouterFetch(fake.fetcher);
  setAiClient(undefined);
  t.after(async () => {
    console.warn = warn;
    setOpenRouterFetch(undefined);
    setAiClient(undefined);
    for (const k of ENVS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@or.test", password: "Password@123", companyName: "Free Models Co" });
  const auth = { Authorization: `Bearer ${generateAccessToken(o.user, o.tenant.id, "owner")}` };
  const status = () => request(app).get("/api/ai/status").set(auth);
  const improve = () => request(app).post("/api/ai/improve").set(auth).send({ text: "hello how can i halp", style: "polish" });

  await t.test("with no key at all, nothing is available", async () => {
    const s = (await status()).body;
    assert.deepEqual([s.available, s.reason, s.provider], [false, "not_configured", null]);
    assert.deepEqual((await request(app).get("/health")).body.ai, { configured: false, provider: null });
  });

  await t.test("an OpenRouter key makes Riwo available, on free models, and the answer is recorded", async () => {
    process.env.OPENROUTER_API_KEY = KEY;
    const s = (await status()).body;
    assert.deepEqual([s.available, s.provider, s.free], [true, "openrouter", true]);
    assert.deepEqual((await request(app).get("/health")).body.ai, { configured: true, provider: "openrouter" });
    const res = await improve();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.text, "Hello from google/gemma-4-31b-it:free");
    assert.equal(res.body.model, "google/gemma-4-31b-it:free");
    const chat = fake.chats().at(-1).body;
    assert.match(chat.messages.find((m) => m.role === "user").content, /<draft>\nhello how can i halp\n<\/draft>/);
    assert.match(chat.messages.find((m) => m.role === "system").content, /Free Models Co/);
    const usage = (await query("SELECT * FROM ai_usage WHERE tenant_id=$1", [o.tenant.id])).rows[0];
    assert.equal(usage.requests, 1);
    assert.equal(Number(usage.input_tokens), 210);
    assert.equal(Number(usage.output_tokens), 40);
  });

  await t.test("a failed request costs the company nothing, and the reason reaches the person", async () => {
    const before = (await status()).body.used;
    const blocked = rejected(404, "No endpoints found matching your data policy (Free model training)");
    const down = fakeOpenRouter({ models: { "google/gemma-4-31b-it:free": blocked, "openai/gpt-oss-120b:free": blocked, [FREE_ROUTER]: blocked } });
    setOpenRouterFetch(down.fetcher);
    const res = await improve();
    assert.equal(res.status, 503);
    assert.match(res.body.message, /privacy settings on the AI account/);
    assert.equal((await status()).body.used, before);
    setOpenRouterFetch(fake.fetcher);
  });

  await t.test("when both keys are set OpenRouter wins, unless AI_PROVIDER names Claude", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    assert.equal((await status()).body.provider, "openrouter");
    process.env.AI_PROVIDER = "anthropic";
    const s = (await status()).body;
    assert.deepEqual([s.provider, s.free], ["anthropic", false]);
    process.env.AI_PROVIDER = "openrouter";
    assert.equal((await status()).body.provider, "openrouter");
    delete process.env.AI_PROVIDER;
    delete process.env.OPENROUTER_API_KEY;
    assert.equal((await status()).body.provider, "anthropic", "Claude is used when it is the only key");
  });
});
