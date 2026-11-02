import crypto from "node:crypto";
import { query, withTransaction } from "../db/index.js";
import { isManager } from "./access.js";
import { chatTitle } from "./personName.js";

// The record of what the machine said. See migration 046. Writing to it must never stop a message from being sent, so
// callers log a failure and carry on; but every message from Riwo or a rule goes through sendTextMessage, which records it, so
// nothing automated can be sent without a row unless the database itself is failing.

export const AUTOMATED_SENDERS = ["Riwo", "Automation"];
const GENESIS = "0".repeat(64);
const fields = (r) => [r.tenant_id, r.conversation_id, r.event, r.source, r.rule_ref, r.trigger_message_id ?? "", r.message_id ?? "", r.provider, r.model, r.text, r.reversible ? 1 : 0, r.undoes ?? "", new Date(r.created_at).toISOString()];
export const hashOf = (prev, r) => crypto.createHash("sha256").update([prev, ...fields(r)].join("\u001f")).digest("hex");

export async function recordAutomated({ tenantId, conversationId, event = "sent", source, ruleRef = "", triggerMessageId = null, messageId = null, provider = "", model = "", text = "", reversible = false, undoes = null }) {
  return withTransaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`audit:${tenantId}`]);
    const prev = (await c.query("SELECT hash FROM automation_audit WHERE tenant_id=$1 ORDER BY id DESC LIMIT 1", [tenantId])).rows[0]?.hash || GENESIS;
    const createdAt = new Date();
    const row = { tenant_id: tenantId, conversation_id: conversationId, event, source, rule_ref: String(ruleRef), trigger_message_id: triggerMessageId, message_id: messageId, provider: String(provider || ""), model: String(model || ""), text: String(text), reversible, undoes, created_at: createdAt };
    const hash = hashOf(prev, row);
    const { rows } = await c.query(
      `INSERT INTO automation_audit(tenant_id,conversation_id,event,source,rule_ref,trigger_message_id,message_id,provider,model,text,reversible,undoes,prev_hash,hash,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [tenantId, conversationId, event, source, row.rule_ref, triggerMessageId, messageId, row.provider, row.model, row.text, reversible, undoes, prev, hash, createdAt],
    );
    return rows[0].id;
  });
}

// Walks the company's chain and says whether every row still matches its hash and follows the one before it.
export async function verifyChain(tenantId) {
  const { rows } = await query("SELECT * FROM automation_audit WHERE tenant_id=$1 ORDER BY id", [tenantId]);
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== hashOf(prev, r)) return { ok: false, checked: rows.length, brokenAtId: Number(r.id) };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAtId: null };
}

const view = (r) => ({
  id: Number(r.id),
  at: r.created_at,
  event: r.event,
  source: r.source,
  rule: r.rule_ref,
  triggerMessageId: r.trigger_message_id,
  messageId: r.message_id,
  provider: r.provider,
  model: r.model,
  text: r.text,
  reversible: r.reversible,
  undoes: r.undoes === null ? null : Number(r.undoes),
  conversationId: r.conversation_id,
  title: chatTitle(r.contact_name, r.phone),
});

// Managers see every row; staff see the rows for chats they may open (their own numbers and chats assigned to them).
export async function listAutomated(req, { conversationId = null, limit = 50, beforeId = null } = {}) {
  const params = [req.tenantId, Math.min(Math.max(Number(limit) || 50, 1), 200)];
  let where = "a.tenant_id=$1";
  if (conversationId) {
    params.push(conversationId);
    where += ` AND a.conversation_id=$${params.length}`;
  }
  if (beforeId) {
    params.push(Number(beforeId));
    where += ` AND a.id<$${params.length}`;
  }
  if (!isManager(req)) {
    params.push(req.user.id);
    where += ` AND (c.assigned_user_id=$${params.length} OR c.session_name IN (SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 AND owner_user_id=$${params.length}))`;
  }
  const { rows } = await query(
    `SELECT a.*,c.contact_name,c.phone FROM automation_audit a LEFT JOIN conversations c ON c.id=a.conversation_id AND c.tenant_id=a.tenant_id WHERE ${where} ORDER BY a.id DESC LIMIT $2`,
    params,
  );
  return rows.map(view);
}
