import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { configuredProviders } from "../src/services/ai/providers.js";
import { complete, resetRouter, routerStatus } from "../src/services/ai/router.js";
import { setAiFetch } from "../src/services/ai/http.js";
import { aiStatus, aiProvider } from "../src/services/aiService.js";

const ENVS = ["GROQ_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CEREBRAS_API_KEY", "MISTRAL_API_KEY", "NVIDIA_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "AI_PROVIDER", "AI_PROVIDERS", "AI_SELF_BASE_URL", "AI_SELF_API_KEY", "AI_SELF_MODEL", "AI_GROQ_RPM", "AI_GROQ_DATA", "AI_GEMINI_DATA", "AI_REQUIRE_NO_TRAINING", "AI_GROQ_MODELS", "AI_GROQ_MODELS_FAST", "AI_ROUTING", "AI_CEREBRAS_RPM", "AI_GEMINI_RPM"];
const saved = Object.fromEntries(ENVS.map((k) => [k, process.env[k]]));
const clean = () => {
  for (const k of ENVS) delete process.env[k];
  resetRouter();
  setAiFetch(null);
};
test.afterEach(clean);
test.after(() => {
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

const ask = { system: "Be brief.", user: "Say hi", maxTokens: 50 };
const ok = (text, extra = {}) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 3, completion_tokens: 2 }, ...extra }) });
const geminiOk = (text) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } }) });
const bad = (status, body = {}, headers = {}) => ({ ok: false, status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) });
const hostOf = (url) => new URL(url).hostname;

test("providers: only those with a key, in the order given, and your own servers first", () => {
  assert.deepEqual(configuredProviders(), []);
  process.env.GEMINI_API_KEY = "g";
  process.env.GROQ_API_KEY = "q";
  process.env.OPENROUTER_API_KEY = "o";
  assert.deepEqual(configuredProviders().map((p) => p.id), ["groq", "gemini", "openrouter"], "the usual order, no key means not used");
  process.env.AI_PROVIDERS = "openrouter, gemini";
  assert.deepEqual(configuredProviders().map((p) => p.id), ["openrouter", "gemini"], "the order the owner chose");
  delete process.env.AI_PROVIDERS;
  process.env.AI_SELF_BASE_URL = "http://10.0.0.5:8000/v1/";
  process.env.AI_SELF_MODEL = "my-model";
  const self = configuredProviders()[0];
  assert.deepEqual([self.id, self.baseUrl, self.models.write, self.policy, self.free], ["self", "http://10.0.0.5:8000/v1", ["my-model"], "no-training", false], "your own GPUs: first, private and not a free tier");
  process.env.AI_PROVIDER = "gemini";
  assert.deepEqual(configuredProviders().map((p) => p.id), ["gemini"], "AI_PROVIDER means that one only");
  assert.equal(aiProvider(), "gemini");
  process.env.AI_PROVIDER = "cerebras";
  assert.deepEqual(configuredProviders(), [], "naming one without a key leaves none");
});

test("the request each provider gets: key in a header, the system words kept apart, the answer tidied", async () => {
  process.env.GROQ_API_KEY = "gsk-secret";
  process.env.GEMINI_API_KEY = "gem-secret";
  const seen = [];
  setAiFetch(async (url, init) => {
    seen.push({ url: String(url), init, body: JSON.parse(init.body) });
    return hostOf(url).includes("groq") ? bad(500) : geminiOk("Hello there");
  });
  const out = await complete(ask, { tier: "fast" });
  assert.equal(out.provider, "gemini");
  assert.equal(out.text, "Hello there");
  const [groq, gem] = seen;
  assert.equal(groq.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(groq.init.headers.authorization, "Bearer gsk-secret");
  assert.deepEqual(groq.body.messages, [{ role: "system", content: "Be brief." }, { role: "user", content: "Say hi" }]);
  assert.equal(groq.body.model, "llama-3.1-8b-instant", "the quick tier uses the small model");
  assert.ok(!gem.url.includes("gem-secret") && !gem.url.includes("key="), "the Google key is never in the address");
  assert.equal(gem.init.headers["x-goog-api-key"], "gem-secret");
  assert.equal(gem.body.systemInstruction.parts[0].text, "Be brief.");
  assert.deepEqual(gem.body.generationConfig.thinkingConfig, { thinkingBudget: 0 }, "Flash does not spend the answer on hidden thinking");
  const tidied = await (async () => {
    clean();
    process.env.GROQ_API_KEY = "x";
    setAiFetch(async () => ok("Sure, here's a reply:\n\n\"On our way!\""));
    return complete(ask);
  })();
  assert.equal(tidied.text, "On our way!");
});

test("a busy provider is skipped for a while, and the next one answers", async () => {
  process.env.GROQ_API_KEY = "q";
  process.env.GEMINI_API_KEY = "g";
  const calls = [];
  setAiFetch(async (url) => {
    calls.push(hostOf(url));
    return hostOf(url).includes("groq") ? bad(429, { error: { message: "rate" } }, { "retry-after": "120" }) : geminiOk("from gemini");
  });
  assert.equal((await complete(ask)).provider, "gemini");
  assert.deepEqual(calls, ["api.groq.com", "generativelanguage.googleapis.com"]);
  const rest = routerStatus().find((p) => p.id === "groq").resting;
  assert.ok(rest && rest.seconds > 100 && rest.seconds <= 120, `it rests for what the provider said: ${JSON.stringify(rest)}`);
  calls.length = 0;
  assert.equal((await complete(ask)).provider, "gemini");
  assert.deepEqual(calls, ["generativelanguage.googleapis.com"], "and is not asked again meanwhile");
});

test("a refused key rests for an hour; a model that is gone is dropped and the next model is tried", async () => {
  process.env.AI_ROUTING = "ordered";
  process.env.GROQ_API_KEY = "q";
  process.env.AI_GROQ_MODELS = "old-model,new-model";
  process.env.GEMINI_API_KEY = "g";
  const models = [];
  setAiFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    if (hostOf(url).includes("groq")) {
      models.push(body.model);
      return body.model === "old-model" ? bad(404, { error: { message: "model not found" } }) : ok("answered by the new model");
    }
    return geminiOk("gemini");
  });
  const out = await complete(ask);
  assert.deepEqual([out.provider, out.model, models], ["groq", "new-model", ["old-model", "new-model"]]);
  models.length = 0;
  await complete(ask);
  assert.deepEqual(models, ["new-model"], "the missing model is not tried again");
  clean();
  process.env.AI_ROUTING = "ordered";
  process.env.GROQ_API_KEY = "q";
  process.env.GEMINI_API_KEY = "g";
  setAiFetch(async (url) => (hostOf(url).includes("groq") ? bad(401, { error: { message: "invalid key gsk-LEAK" } }) : geminiOk("gemini")));
  await complete(ask);
  const rest = routerStatus().find((p) => p.id === "groq").resting;
  assert.equal(rest.reason, "the key was refused");
  assert.ok(rest.seconds > 3000, "an hour, not a minute");
});

test("each provider is held to its own number of requests a minute, and background work uses half", async () => {
  process.env.AI_ROUTING = "ordered";
  process.env.GROQ_API_KEY = "q";
  process.env.AI_GROQ_RPM = "4";
  process.env.GEMINI_API_KEY = "g";
  const who = [];
  setAiFetch(async (url) => {
    who.push(hostOf(url).includes("groq") ? "groq" : "gemini");
    return hostOf(url).includes("groq") ? ok("g") : geminiOk("m");
  });
  for (let i = 0; i < 6; i++) await complete(ask);
  assert.deepEqual(who, ["groq", "groq", "groq", "groq", "gemini", "gemini"], "four to the first, then the next takes over");
  clean();
  process.env.AI_ROUTING = "ordered";
  process.env.GROQ_API_KEY = "q";
  process.env.AI_GROQ_RPM = "4";
  process.env.GEMINI_API_KEY = "g";
  who.length = 0;
  setAiFetch(async (url) => {
    who.push(hostOf(url).includes("groq") ? "groq" : "gemini");
    return hostOf(url).includes("groq") ? ok("g") : geminiOk("m");
  });
  for (let i = 0; i < 3; i++) await complete(ask, { priority: "background" });
  assert.deepEqual(who, ["groq", "groq", "gemini"], "background work leaves half for people");
});

const nameOf = (url) => (hostOf(url).includes("groq") ? "groq" : hostOf(url).includes("cerebras") ? "cerebras" : hostOf(url).includes("openrouter") ? "openrouter" : hostOf(url).includes("anthropic") ? "anthropic" : hostOf(url).startsWith("10.") ? "self" : "gemini");

test("balanced is the default: free providers take turns in proportion to their size, so none is drained first", async () => {
  process.env.GROQ_API_KEY = "q";
  process.env.GEMINI_API_KEY = "g";
  process.env.CEREBRAS_API_KEY = "c";
  process.env.AI_GROQ_RPM = "20";
  process.env.AI_GEMINI_RPM = "10";
  process.env.AI_CEREBRAS_RPM = "10";
  const who = [];
  setAiFetch(async (url) => {
    who.push(nameOf(url));
    return nameOf(url) === "gemini" ? geminiOk("m") : ok("g");
  });
  for (let i = 0; i < 12; i++) await complete(ask);
  const count = (n) => who.filter((w) => w === n).length;
  assert.deepEqual([count("groq"), count("gemini"), count("cerebras")], [6, 3, 3], `groq is twice the size, so it takes twice the turns: ${who}`);
  assert.notDeepEqual(who.slice(0, 3), ["groq", "groq", "groq"], "not one provider until it is empty");
  const status = routerStatus();
  assert.equal(status.find((p) => p.id === "groq").answered, 6);
});

test("a provider that is out of daily allowance rests for hours and the others carry its share", async () => {
  process.env.GROQ_API_KEY = "q";
  process.env.GEMINI_API_KEY = "g";
  process.env.CEREBRAS_API_KEY = "c";
  const who = [];
  setAiFetch(async (url) => {
    who.push(nameOf(url));
    if (nameOf(url) === "groq") return bad(429, { error: { message: "Rate limit reached for model on tokens per day (TPD): Limit 100000" } }, { "retry-after": "7200" });
    return nameOf(url) === "gemini" ? geminiOk("m") : ok("c");
  });
  for (let i = 0; i < 6; i++) assert.notEqual((await complete(ask)).provider, "groq", "every customer still gets an answer");
  assert.equal(who.filter((w) => w === "groq").length, 1, "asked once, then left alone");
  const rest = routerStatus().find((p) => p.id === "groq").resting;
  assert.match(rest.reason, /daily/);
  assert.ok(rest.seconds > 7000 && rest.seconds <= 7200, "for as long as it said");
  // an ordinary "slow down" is a short rest, not hours
  clean();
  process.env.GROQ_API_KEY = "q";
  process.env.GEMINI_API_KEY = "g";
  setAiFetch(async (url) => (nameOf(url) === "groq" ? bad(429, { error: { message: "slow down" } }, { "retry-after": "30" }) : geminiOk("m")));
  await complete(ask);
  await complete(ask);
  assert.ok(routerStatus().find((p) => p.id === "groq").resting.seconds <= 30);
});

test("your own server always goes first and paid Claude last, whatever the rotation", async () => {
  process.env.AI_SELF_BASE_URL = "http://10.0.0.5:8000/v1";
  process.env.AI_SELF_MODEL = "mine";
  process.env.GROQ_API_KEY = "q";
  process.env.GEMINI_API_KEY = "g";
  process.env.ANTHROPIC_API_KEY = "a";
  const who = [];
  setAiFetch(async (url) => {
    who.push(nameOf(url));
    return nameOf(url) === "gemini" ? geminiOk("m") : ok("x");
  });
  for (let i = 0; i < 4; i++) assert.equal((await complete(ask, {}, { anthropic: async () => ({ text: "claude" }) })).provider, "self");
  assert.deepEqual([...new Set(who)], ["self"], "free tiers are not touched while your own server answers");
  // your server goes down: the free ones take over, and Claude is the last resort
  who.length = 0;
  setAiFetch(async (url) => {
    who.push(nameOf(url));
    return nameOf(url) === "self" ? bad(503) : nameOf(url) === "gemini" ? geminiOk("m") : bad(500);
  });
  const claude = async () => ({ text: "claude" });
  const out = await complete(ask, {}, { anthropic: claude });
  assert.ok(["gemini"].includes(out.provider) || out.provider === "anthropic");
  assert.equal(who[0], "self");
  clean();
  process.env.GROQ_API_KEY = "q";
  process.env.ANTHROPIC_API_KEY = "a";
  setAiFetch(async () => bad(500));
  assert.equal((await complete(ask, {}, { anthropic: claude })).provider, "anthropic", "free ones failed, Claude answers");
});

test("AI_ROUTING=ordered keeps strict priority", async () => {
  process.env.AI_ROUTING = "ordered";
  process.env.GROQ_API_KEY = "q";
  process.env.GEMINI_API_KEY = "g";
  const who = [];
  setAiFetch(async (url) => {
    who.push(nameOf(url));
    return nameOf(url) === "gemini" ? geminiOk("m") : ok("x");
  });
  for (let i = 0; i < 4; i++) await complete(ask);
  assert.deepEqual(who, ["groq", "groq", "groq", "groq"]);
});

test("the only provider is still tried when it is resting: the rest was a guess", async () => {
  process.env.GROQ_API_KEY = "q";
  let n = 0;
  setAiFetch(async () => (++n === 1 ? bad(503) : ok("back again")));
  await assert.rejects(complete(ask), /answered 503|could not be reached|AI provider/);
  assert.equal((await complete(ask)).text, "back again");
});

test("customer messages only go to providers that keep them private when that is asked for, by the company or the server", async () => {
  process.env.GEMINI_API_KEY = "g";
  process.env.GROQ_API_KEY = "q";
  const hit = [];
  setAiFetch(async (url) => {
    hit.push(hostOf(url).includes("groq") ? "groq" : "gemini");
    return hostOf(url).includes("groq") ? bad(500) : geminiOk("gemini");
  });
  process.env.AI_PROVIDERS = "gemini";
  await complete(ask);
  assert.deepEqual(hit, ["gemini"], "without the setting, a free tier may be used");
  hit.length = 0;
  await assert.rejects(complete(ask, { privateOnly: true }), /keeps your messages private/, "gemini's free tier may train on what it gets");
  assert.deepEqual(hit, [], "nothing was sent");
  process.env.AI_REQUIRE_NO_TRAINING = "1";
  await assert.rejects(complete(ask), /keeps your messages private/, "the whole server can require it");
  assert.equal((await complete(ask, { sensitivity: "general" })).provider, "gemini", "things that are not customers' words are not held to it");
  delete process.env.AI_REQUIRE_NO_TRAINING;
  process.env.AI_GEMINI_DATA = "no-training"; // a paid Google account
  process.env.AI_PROVIDERS = "gemini,groq";
  assert.equal((await complete(ask, { privateOnly: true })).provider, "gemini");
});

test("Riwo works through the router: failover, status, the company's private-only switch, and the settings test", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@router.test", password: "Password@123", companyName: "Router Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  process.env.GEMINI_API_KEY = "g";
  process.env.GROQ_API_KEY = "q";
  setAiFetch(async (url) => (hostOf(url).includes("groq") ? bad(429) : geminiOk("Hi")));
  const tenant = () => query("SELECT * FROM tenants WHERE id=$1", [tenantId]).then((r) => r.rows[0]);

  const status = await request(app).get("/api/ai/status").set(owner);
  assert.deepEqual([status.body.available, status.body.provider, status.body.free, status.body.mayKeepMessages, status.body.privateOnly], [true, "groq", true, true, false]);

  const set = await request(app).put("/api/ai/settings").set(owner).send({ privateOnly: true });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual([set.body.privateOnly, set.body.enabled, set.body.mayKeepMessages], [true, true, false]);
  assert.equal((await request(app).put("/api/ai/settings").set(owner).send({ privateOnly: "yes" })).status, 400);
  assert.equal((await request(app).put("/api/ai/settings").set(owner).send({})).status, 400);

  // with the switch on, groq is the only connected provider that does not train, and it is busy: gemini must not be used
  const refused = await request(app).post("/api/ai/improve").set(owner).send({ text: "hello", style: "polish" });
  assert.equal(refused.status, 429, JSON.stringify(refused.body));

  await request(app).put("/api/ai/settings").set(owner).send({ privateOnly: false });
  const fine = await request(app).post("/api/ai/improve").set(owner).send({ text: "hello", style: "polish" });
  assert.equal(fine.status, 200, JSON.stringify(fine.body));
  assert.equal(fine.body.text, "Hi", "the company that did not ask for private-only gets the next provider");

  // only a provider that is not private is connected, and the company asked for private: Riwo says why
  clean();
  process.env.GEMINI_API_KEY = "g";
  await request(app).put("/api/ai/settings").set(owner).send({ privateOnly: true });
  const none = await aiStatus(await tenant());
  assert.deepEqual([none.available, none.reason], [false, "no_private_provider"]);

  clean();
  process.env.GEMINI_API_KEY = "g";
  process.env.GROQ_API_KEY = "q";
  setAiFetch(async (url) => (hostOf(url).includes("groq") ? bad(401) : geminiOk("OK")));
  const test = await request(app).post("/api/ai/test").set(owner);
  assert.equal(test.status, 200, JSON.stringify(test.body));
  assert.equal(test.body.ok, true, "one working provider is enough");
  assert.deepEqual(test.body.providers.map((p) => [p.id, p.ok, p.policy]), [["groq", false, "no-training"], ["gemini", true, "may-train"]]);
  assert.ok(!JSON.stringify(test.body).includes("secret"), "no key in what is shown");
});

