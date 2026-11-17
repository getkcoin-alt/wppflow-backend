import request from "supertest";
import { app } from "../../src/server.js";
import { query } from "../../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../../src/services/authService.js";
import { handleIncomingMessage } from "../../src/services/messageService.js";
import { defaultWhatsAppProvider as provider } from "../../src/services/whatsapp/WhatsAppProvider.js";

// A company on the Business plan with a few numbers, a teammate, and helpers to make customers write, make agents, and call them the way
// an AI agent would (MCP, or REST). Only WhatsApp is not real: marking a chat read is a no-op.
provider.markRead = async () => {};

let counter = 0;
export async function agentCompany(label, { plan = "Business", numbers = ["main-line", "second-line"] } = {}) {
  const n = ++counter;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const o = await registerTenantAndUser({ name: `${label} Owner`, email: `owner.${slug}${n}@agent.test`, password: "Password@123", companyName: `${label} Stores` });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan=$2 WHERE id=$1", [tenantId, plan]);
  for (const [i, name] of numbers.entries())
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,phone,status) VALUES(gen_random_uuid()::text,$1,$2,$3,$4,'CONNECTED')", [tenantId, name, o.user.id, `97150${String(n).padStart(3, "0")}${i}00`]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };

  const person = async (name, role) => {
    const u = (await registerTenantAndUser({ name, email: `${name.toLowerCase().replace(/\W+/g, ".")}.${slug}${n}@agent.test`, password: "Password@123", companyName: `${name}'s own ${n}` })).user;
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)", [tenantId, u.id, role]);
    return { ...u, role, auth: { Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` } };
  };
  const sam = await person("Sam Agent", "agent");

  let seq = 0;
  // a customer writes on one of the numbers: this makes the contact and the chat, as in real life
  const customer = async (phone, name, { line = numbers[0], text = "hello", ago = 0 } = {}) => {
    seq += 1;
    await handleIncomingMessage({
      tenantId,
      sessionName: line,
      msg: { providerMessageId: `true_${phone}@c.us_${n}_${seq}`, fromMe: false, remoteId: `${phone}@c.us`, rawType: "chat", type: "text", text, timestampEpoch: Math.floor(Date.now() / 1000) - ago - 60 + seq, senderName: name },
    });
    const contact = (await query("SELECT id FROM contacts WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows[0]?.id;
    const chat = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND session_name=$2 AND provider_chat_id=$3", [tenantId, line, `${phone}@c.us`])).rows[0].id;
    return { contact, chat, phone, name, line };
  };
  // a further message in a chat that exists
  const says = (c, text, { ago = 0 } = {}) => {
    seq += 1;
    return handleIncomingMessage({
      tenantId,
      sessionName: c.line,
      msg: { providerMessageId: `true_${c.phone}@c.us_${n}_${seq}`, fromMe: false, remoteId: `${c.phone}@c.us`, rawType: "chat", type: "text", text, timestampEpoch: Math.floor(Date.now() / 1000) - ago - 60 + seq, senderName: c.name },
    });
  };
  const group = async (name, { line = numbers[0] } = {}) => {
    const id = `grp_${n}_${++seq}`;
    await query(
      "INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,phone,contact_name,is_group,last_active_epoch) VALUES($1,$2,$3,$4,$5,$6,true,extract(epoch FROM now())::bigint)",
      [id, tenantId, line, `120363${seq}@g.us`, `120363${seq}@g.us`, name],
    );
    return id;
  };

  // an agent, made the way the screen makes it. Returns the agent with its key.
  const makeAgent = async (body = {}) => {
    const res = await request(app).post("/api/agents").set(owner).send({ name: "Claude helper", level: "reply", ...body });
    if (res.status !== 201) throw new Error(`agent not made: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.agent;
  };

  return { n, tenantId, owner, user: o.user, sam, customer, says, group, makeAgent, numbers };
}

export const bearer = (key) => ({ Authorization: `Bearer ${key}` });

// one JSON-RPC call to the MCP server, as a client would make it
export const rpc = (key, method, params, { id = 1, version, path = "/mcp", headers = {} } = {}) =>
  request(app)
    .post(path)
    .set({ ...bearer(key), Accept: "application/json, text/event-stream", ...(version ? { "MCP-Protocol-Version": version } : {}), ...headers })
    .send({ jsonrpc: "2.0", id, method, params });

// a tool through MCP: the parsed answer, or { error } with what the agent would read
export async function mcpTool(key, name, args = {}, opts = {}) {
  const res = await rpc(key, "tools/call", { name, arguments: args }, { version: "2025-06-18", ...opts });
  if (res.body.error) return { rpcError: res.body.error };
  const r = res.body.result;
  const text = r.content[0].text;
  return r.isError ? { error: text } : JSON.parse(text);
}

// a tool through REST: { status, body }
export const restTool = (key, name, args = {}) => request(app).post(`/api/agent/v1/tools/${name}`).set(bearer(key)).send(args);

export const rowsOf = async (sql, params) => (await query(sql, params)).rows;
