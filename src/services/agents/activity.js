import { query, withTransaction } from "../../db/index.js";
import { chatTitle } from "../personName.js";
import { agentError } from "./keys.js";
import { KEEP_EVENT_DAYS, RESERVATION_SECONDS } from "./config.js";

// What each agent did, one short row per call (never the text of a message: that is in the chat and in the AI accountability record).
// It is what the owner reads on the AI agents screen, and what the sending limits are counted from.
const clip = (value, n) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export async function recordEvent({ tenantId, agentId, tool, ok, conversationId = null, summary = "", errorCode = null, ms = null, via = "mcp" }) {
  try {
    await query(
      "INSERT INTO agent_events(tenant_id,agent_id,tool,ok,conversation_id,summary,error_code,ms,via) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [tenantId, agentId, tool, ok, conversationId, clip(summary, 240), errorCode ? clip(errorCode, 40) : null, ms === null ? null : Math.round(ms), ["rest", "test"].includes(via) ? via : "mcp"],
    );
  } catch (error) {
    // writing the record must never stop the agent's work
    console.error("Agent event not recorded:", error.message);
  }
}

// A message counts against the limits while it is being sent and once it was sent; one that failed does not, and a reservation the process
// never finished stops counting after a couple of minutes.
// (a send that turned out to be the same message again is on the record, but nothing was sent, so it does not count)
export const SENT = "tool='send_message' AND ok IS TRUE AND error_code IS DISTINCT FROM 'duplicate'";
const COUNTED = `tool='send_message' AND NOT first_message AND error_code IS DISTINCT FROM 'duplicate' AND (ok IS TRUE OR (ok IS NULL AND created_at > now() - $2::int * interval '1 second'))`;

const wait = (seconds) => {
  const s = Math.max(1, Math.ceil(Number(seconds) || 1));
  return s < 90 ? `${s} seconds` : s < 5400 ? `${Math.ceil(s / 60)} minutes` : `${Math.ceil(s / 3600)} hours`;
};

// Checks the agent's limits and, if it may send, writes a reservation (counted at once, so two calls at the same moment cannot both pass).
// Returns the event id to settle after the send.
export async function reserveSend(agent, conversationId, { via = "mcp", firstMessage = false } = {}) {
  return withTransaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-send:${agent.id}`]);
    // The first message of a chat with a new number was already allowed by the new-number limits (reserveNewChat), and does not use up the
    // limits for existing customers.
    if (firstMessage) {
      const first = await c.query("INSERT INTO agent_events(tenant_id,agent_id,tool,ok,conversation_id,summary,via,first_message) VALUES($1,$2,'send_message',NULL,$3,'Sending a message',$4,true) RETURNING id", [agent.tenant_id, agent.id, conversationId, ["rest", "test"].includes(via) ? via : "mcp"]);
      return first.rows[0].id;
    }
    const { rows } = await c.query(
      `SELECT
         count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour,
         count(*)::int AS day,
         count(*) FILTER (WHERE conversation_id=$3 AND created_at > now() - interval '1 hour')::int AS chat,
         ceil(extract(epoch FROM (min(created_at) FILTER (WHERE created_at > now() - interval '1 hour') + interval '1 hour' - now())))::int AS hour_wait,
         ceil(extract(epoch FROM (min(created_at) + interval '24 hours' - now())))::int AS day_wait,
         ceil(extract(epoch FROM (min(created_at) FILTER (WHERE conversation_id=$3 AND created_at > now() - interval '1 hour') + interval '1 hour' - now())))::int AS chat_wait
       FROM agent_events WHERE agent_id=$1 AND ${COUNTED} AND created_at > now() - interval '24 hours'`,
      [agent.id, RESERVATION_SECONDS, conversationId],
    );
    const n = rows[0];
    if (n.chat >= agent.per_chat_hour)
      throw agentError(429, "limit_reached", `This agent has already sent ${n.chat} messages to this chat in the last hour (its limit is ${agent.per_chat_hour}).`, `Wait ${wait(n.chat_wait)}, or ask an owner or admin to raise the limit under Developers, AI agents. Do not keep messaging the same customer.`, {
        retryAfter: Math.max(1, n.chat_wait),
      });
    if (n.hour >= agent.per_hour)
      throw agentError(429, "limit_reached", `This agent has reached its limit of ${agent.per_hour} messages an hour.`, `Wait ${wait(n.hour_wait)}, or ask an owner or admin to raise the limit under Developers, AI agents.`, { retryAfter: Math.max(1, n.hour_wait) });
    if (n.day >= agent.per_day)
      throw agentError(429, "limit_reached", `This agent has reached its limit of ${agent.per_day} messages in 24 hours.`, `Wait ${wait(n.day_wait)}, or ask an owner or admin to raise the limit under Developers, AI agents.`, { retryAfter: Math.max(1, n.day_wait) });
    const made = await c.query(
      "INSERT INTO agent_events(tenant_id,agent_id,tool,ok,conversation_id,summary,via) VALUES($1,$2,'send_message',NULL,$3,'Sending a message',$4) RETURNING id",
      [agent.tenant_id, agent.id, conversationId, ["rest", "test"].includes(via) ? via : "mcp"],
    );
    return made.rows[0].id;
  });
}

// Starting a chat with a new number has its own daily cap (checked and reserved under its own lock, like a send), counted in 24 hours.
export async function reserveNewChat(agent, { via = "mcp" } = {}) {
  return withTransaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-newchat:${agent.id}`]);
    const { rows } = await c.query(
      `SELECT count(*)::int AS day,
              count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour,
              ceil(extract(epoch FROM (min(created_at) + interval '24 hours' - now())))::int AS day_wait,
              ceil(extract(epoch FROM (min(created_at) FILTER (WHERE created_at > now() - interval '1 hour') + interval '1 hour' - now())))::int AS hour_wait
         FROM agent_events WHERE agent_id=$1 AND tool='message_new_number' AND (ok IS TRUE OR (ok IS NULL AND created_at > now() - $2::int * interval '1 second')) AND created_at > now() - interval '24 hours'`,
      [agent.id, RESERVATION_SECONDS],
    );
    const n = rows[0];
    if (n.hour >= agent.new_chats_per_hour)
      throw agentError(429, "limit_reached", `This agent has already started ${n.hour} chats with new numbers in the last hour (its limit is ${agent.new_chats_per_hour} an hour).`, `Wait ${wait(n.hour_wait)}, or ask an owner or admin to raise the limit under Developers, AI agents. Do not look for another way to reach new people.`, { retryAfter: Math.max(1, n.hour_wait) });
    if (n.day >= agent.new_chats_per_day)
      throw agentError(429, "limit_reached", `This agent has already started ${n.day} chats with new numbers in 24 hours (its limit is ${agent.new_chats_per_day}).`, `Wait ${wait(n.day_wait)}, or ask an owner or admin to raise the limit under Developers, AI agents. Do not look for another way to reach new people.`, { retryAfter: Math.max(1, n.day_wait) });
    const made = await c.query("INSERT INTO agent_events(tenant_id,agent_id,tool,ok,summary,via) VALUES($1,$2,'message_new_number',NULL,'Starting a chat with a new number',$3) RETURNING id", [agent.tenant_id, agent.id, ["rest", "test"].includes(via) ? via : "mcp"]);
    return made.rows[0].id;
  });
}

export async function settleSend(eventId, { ok, summary = "", errorCode = null, ms = null, conversationId = null }) {
  try {
    await query("UPDATE agent_events SET ok=$2,summary=$3,error_code=$4,ms=$5,conversation_id=COALESCE($6,conversation_id) WHERE id=$1", [eventId, ok, clip(summary, 240), errorCode ? clip(errorCode, 40) : null, ms === null ? null : Math.round(ms), conversationId]);
  } catch (error) {
    console.error("Agent send not settled:", error.message);
  }
}

// What an agent has sent lately (for its own overview, so it can pace itself)
export async function usageOf(agent) {
  const { rows } = await query(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour, count(*)::int AS day
       FROM agent_events WHERE agent_id=$1 AND ${COUNTED} AND created_at > now() - interval '24 hours'`,
    [agent.id, RESERVATION_SECONDS],
  );
  return { sentLastHour: rows[0].hour, sentLast24h: rows[0].day };
}

export async function listEvents(tenantId, { agentId = null, limit = 50, beforeId = null, onlyChanges = false } = {}) {
  const params = [tenantId];
  let where = "e.tenant_id=$1";
  if (agentId) {
    params.push(String(agentId));
    where += ` AND e.agent_id=$${params.length}`;
  }
  if (beforeId) {
    params.push(Number(beforeId) || 0);
    where += ` AND e.id<$${params.length}`;
  }
  if (onlyChanges) where += " AND e.tool IN ('send_message','message_new_number','add_note','mark_read','assign_conversation','set_status','update_labels','create_task','complete_task')";
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const { rows } = await query(
    `SELECT e.id,e.agent_id,k.name AS agent_name,e.tool,e.ok,e.conversation_id,e.summary,e.error_code,e.ms,e.via,e.created_at,c.contact_name,c.phone,c.is_group
       FROM agent_events e JOIN agent_keys k ON k.id=e.agent_id
       LEFT JOIN conversations c ON c.id=e.conversation_id AND c.tenant_id=e.tenant_id
      WHERE ${where} ORDER BY e.id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    at: r.created_at,
    agentId: r.agent_id,
    agent: r.agent_name,
    tool: r.tool,
    // null while a send is still being made
    ok: r.ok,
    chatId: r.conversation_id,
    // a chat id that matched no chat of this company (a made-up one) has no name to show
    chat: r.conversation_id && (r.contact_name !== null || r.phone !== null) ? chatTitle(r.contact_name, r.phone, { isGroup: r.is_group }) : null,
    summary: r.summary,
    errorCode: r.error_code,
    ms: r.ms,
    via: r.via,
  }));
}

// Old rows go; a send that was reserved and never finished is closed as failed. The jobs run every few seconds; this needs to run every ten minutes.
let lastPump = 0;
export async function pumpAgents({ force = false } = {}) {
  if (!force && Date.now() - lastPump < 10 * 60 * 1000) return;
  lastPump = Date.now();
  await query("UPDATE agent_events SET ok=FALSE,error_code='abandoned',summary='The send did not finish' WHERE ok IS NULL AND created_at < now() - interval '10 minutes'");
  await query("DELETE FROM agent_events WHERE created_at < now() - $1::int * interval '1 day'", [KEEP_EVENT_DAYS]);
}
