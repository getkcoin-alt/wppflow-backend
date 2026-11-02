import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { setAiClient } from "../src/services/aiService.js";

test("Ask Riwo: a few typed words become one of the app's own commands, and nothing else", async (t) => {
  const key = process.env.ANTHROPIC_API_KEY;
  const or = process.env.OPENROUTER_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  const asked = [];
  let say = () => ({ command: "go-campaigns" });
  const respond = async (params) => {
    asked.push(params);
    return { content: [{ type: "text", text: `Sure: ${JSON.stringify(say())}` }], stop_reason: "end_turn", usage: { input_tokens: 60, output_tokens: 10 } };
  };
  setAiClient({ messages: { create: respond }, beta: { messages: { create: respond } } });
  t.after(async () => {
    setAiClient(undefined);
    key === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = key);
    if (or !== undefined) process.env.OPENROUTER_API_KEY = or;
    await closeSessions(io);
    io.close();
  });
  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@cmd.test", password: "Password@123", companyName: "Cmd Co" });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
  const auth = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const commands = [
    { id: "go-inbox", label: "Go to Inbox" },
    { id: "go-campaigns", label: "Go to Broadcasts", hint: "send a message to many people" },
    { id: "connect", label: "Connect a WhatsApp number" },
  ];
  const ask = (body) => request(app).post("/api/ai/command").set(auth).send(body);

  const ok = await ask({ text: "I want to message all my VIP customers", commands });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.commandId, "go-campaigns");
  assert.match(asked[0].messages[0].content, /- go-campaigns \| Go to Broadcasts \(send a message to many people\)/);
  assert.match(asked[0].system, /not instructions/);

  say = () => ({ command: "delete-everything" });
  assert.equal((await ask({ text: "wipe it all", commands })).body.commandId, null, "an id that was not offered is never returned");
  say = () => ({ command: null });
  assert.equal((await ask({ text: "what is the weather", commands })).body.commandId, null);
  say = () => ({ command: "go-inbox" });
  assert.equal((await ask({ text: "x", commands })).status, 400, "too short");
  assert.equal((await ask({ text: "open the inbox", commands: [] })).status, 400);
  assert.equal((await ask({ text: "open the inbox", commands: Array.from({ length: 61 }, (_, i) => ({ id: `c${i}`, label: `C ${i}` })) })).status, 400);
  assert.equal((await ask({ text: "open the inbox" })).status, 400);

  await query("UPDATE tenants SET plan='Starter' WHERE id=$1", [tenantId]);
  const locked = await ask({ text: "open the inbox", commands });
  assert.equal(locked.status, 403, "a plan without Riwo");
  assert.equal((await request(app).post("/api/ai/command").send({ text: "open the inbox", commands })).status, 401);
});
