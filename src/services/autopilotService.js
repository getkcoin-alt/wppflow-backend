import crypto from "node:crypto";
import { query } from "../db/index.js";
import { fail } from "../middleware/http.js";
import { chooseSavedReply, unavailableReason, usageOf } from "./aiService.js";
import { sendTextMessage, deleteMessage } from "./messageService.js";
import { personalise } from "./templating.js";
import { emitForConversation } from "./realtime.js";
import { assertConversationAccess, isManager } from "./access.js";
import { chatTitle } from "./personName.js";
import { withDisclosure } from "./handoffService.js";
import { recordAutomated } from "./auditTrail.js";

// Autopilot: what a company lets Riwo do by itself. Everything is off until an owner switches it on, and each rule is small
// enough to explain in a sentence.
//
//   saved_replies  A customer asks something one of the company's own saved replies fully answers: that reply is sent,
//                  word for word. Riwo only picks; it never writes what the customer reads, so it cannot invent a price.
//   thanks_done    A customer only says thanks or OK: the chat is taken off the list of people waiting. Nothing is sent.
//
// And always: never a group, never a chat a teammate owns or has answered lately, never twice in a few hours, never when
// the customer sounds unhappy or urgent, never to someone who opted out, and no more than a set number a day. Every action
// is recorded, shown to the team, and can be taken back.

export const RULES = {
  saved_replies: {
    label: "Answer questions with my saved replies",
    description: "When a saved reply fully answers what a customer asked, Riwo sends that reply, word for word. It never writes anything of its own.",
  },
  thanks_done: {
    label: "Clear thank-yous",
    description: "When a customer only says thanks or OK, Riwo takes the chat off your waiting list. Nothing is sent.",
  },
};
export const AUTOPILOT = { everyMs: 20_000, settleSeconds: 20, perTenantPerRun: 3, dailyCap: 50, humanQuietMinutes: 30, perChatHours: 6 };
const HUMAN = `NOT (m.agent_name = ANY(ARRAY['Riwo','Automation','Campaign']))`;
const THANKS = /^\s*(?:thanks?(?: you)?(?: so much| a lot| very much)?|thank u|thx|ty|ok(?:ay)?(?: thanks?)?|great(?: thanks?)?|got it|noted|perfect|cool|👍|🙏|👌|✅|شكرا|شكراً|धन्यवाद|शुक्रिया)\s*[.!]*\s*$/iu;
export const isThanks = (text) => THANKS.test(String(text ?? "")) && String(text).length <= 40;

export async function rulesOf(tenantId) {
  const { rows } = await query("SELECT rule_key,enabled FROM autopilot_rules WHERE tenant_id=$1", [tenantId]);
  return Object.fromEntries(Object.keys(RULES).map((key) => [key, rows.some((r) => r.rule_key === key && r.enabled)]));
}
export async function setRule(tenantId, key, enabled, userId) {
  if (!RULES[key]) throw fail(400, "That is not an Autopilot rule.");
  await query(
    `INSERT INTO autopilot_rules(tenant_id,rule_key,enabled,updated_by) VALUES($1,$2,$3,$4)
     ON CONFLICT (tenant_id,rule_key) DO UPDATE SET enabled=$3, updated_by=$4, updated_at=now()`,
    [tenantId, key, Boolean(enabled), userId ?? null],
  );
}
export async function sentToday(tenantId) {
  return (await query(`SELECT count(*)::int AS n FROM autopilot_log WHERE tenant_id=$1 AND outcome='sent' AND created_at >= (now() AT TIME ZONE 'UTC')::date`, [tenantId])).rows[0].n;
}

// Waiting chats whose latest customer message Autopilot has not looked at yet.
export async function candidates(tenantId, limit = AUTOPILOT.perTenantPerRun, now = Math.floor(Date.now() / 1000)) {
  const { rows } = await query(
    `SELECT c.id, c.assigned_user_id, c.needs_human_since, c.contact_name, c.phone, last.id AS message_id, last.text AS text, last.type AS type, c.awaiting_since
       FROM conversations c
       JOIN LATERAL (SELECT m.id,m.text,m.type FROM messages m WHERE m.tenant_id=c.tenant_id AND m.conversation_id=c.id AND m.sender='customer'
                      ORDER BY m.timestamp_epoch DESC, m.id DESC LIMIT 1) last ON true
      WHERE c.tenant_id=$1 AND c.awaiting_since IS NOT NULL AND NOT c.is_closed AND NOT c.is_group
        AND c.provider_chat_id !~ '@(broadcast|newsletter)$' AND c.awaiting_since < $2
        AND NOT EXISTS (SELECT 1 FROM autopilot_log l WHERE l.tenant_id=c.tenant_id AND l.trigger_message_id=last.id)
      ORDER BY c.awaiting_since ASC LIMIT $3`,
    [tenantId, now - AUTOPILOT.settleSeconds, limit],
  );
  return rows;
}

// Takes the message for this run, so two servers never act on the same one.
async function claim(tenantId, conversationId, messageId, ruleKey, priorAwaiting) {
  const id = crypto.randomUUID();
  const { rowCount } = await query(
    `INSERT INTO autopilot_log(id,tenant_id,conversation_id,trigger_message_id,rule_key,outcome,prior_awaiting_since) VALUES($1,$2,$3,$4,$5,'working',$6)
     ON CONFLICT (tenant_id,trigger_message_id) DO NOTHING`,
    [id, tenantId, conversationId, messageId, ruleKey, priorAwaiting],
  );
  return rowCount ? id : null;
}
const finish = (id, outcome, fields = {}) =>
  query("UPDATE autopilot_log SET outcome=$2, reason=$3, text=$4, reply_message_id=$5, updated_at=now() WHERE id=$1", [id, outcome, fields.reason || "", fields.text || "", fields.replyMessageId || null]);

// Why this chat must be left to a person, or null when Autopilot may act.
async function holdBack(tenant, chat) {
  if (chat.assigned_user_id) return "a teammate owns this chat";
  if (chat.needs_human_since) return "the customer asked for a person";
  const recent = (
    await query(
      `SELECT
        EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id=$1 AND m.conversation_id=$2 AND m.sender='agent' AND m.type<>'internal_note' AND ${HUMAN}
                AND m.created_at > now() - make_interval(mins=>$3)) AS human,
        EXISTS (SELECT 1 FROM autopilot_log l WHERE l.tenant_id=$1 AND l.conversation_id=$2 AND l.outcome='sent'
                AND l.created_at > now() - make_interval(hours=>$4)) AS auto,
        EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id=$1 AND s.phone=$5) AS blocked,
        EXISTS (SELECT 1 FROM automation_chats a WHERE a.tenant_id=$1 AND a.conversation_id=$2 AND a.status='active') AS chatting,
        EXISTS (SELECT 1 FROM consents k WHERE k.tenant_id=$1 AND k.phone=$5 AND NOT k.opt_in_status AND k.source='customer_message') AS stopped`,
      [tenant.id, chat.id, AUTOPILOT.humanQuietMinutes, AUTOPILOT.perChatHours, chat.phone],
    )
  ).rows[0];
  if (recent.human) return "a teammate answered lately";
  if (recent.auto) return "already answered a few hours ago";
  if (recent.blocked) return "this customer is blocked";
  if (recent.stopped) return "this customer asked to stop";
  if (recent.chatting) return "Riwo is already chatting here";
  if ((await sentToday(tenant.id)) >= AUTOPILOT.dailyCap) return "today's limit was reached";
  return null;
}

export async function handle(tenant, rules, chat, io = null) {
  const wantsThanks = rules.thanks_done && chat.type === "text" && isThanks(chat.text);
  const wantsReply = rules.saved_replies && chat.type === "text";
  if (!wantsThanks && !wantsReply) return null;
  const logId = await claim(tenant.id, chat.id, chat.message_id, wantsThanks ? "thanks_done" : "saved_replies", chat.awaiting_since);
  if (!logId) return null;
  try {
    if (wantsThanks) {
      // nothing is sent, so a teammate who owns the chat does not matter, but a person who is answering does
      await query("UPDATE conversations SET awaiting_since=NULL, updated_at=now() WHERE id=$1 AND tenant_id=$2 AND awaiting_since IS NOT DISTINCT FROM $3", [chat.id, tenant.id, chat.awaiting_since]);
      await finish(logId, "cleared", { reason: "only said thanks", text: String(chat.text).slice(0, 80) });
      await recordAutomated({ tenantId: tenant.id, conversationId: chat.id, event: "cleared", source: "autopilot", ruleRef: "thanks_done", triggerMessageId: chat.message_id, text: String(chat.text).slice(0, 80), reversible: true }).catch((e) => console.error("Audit record failed:", e.message));
      emitForConversation(io, tenant.id, chat.id, "home:changed", { conversationId: chat.id });
      return "cleared";
    }
    const held = await holdBack(tenant, chat);
    if (held) return await finish(logId, "skipped", { reason: held }), "skipped";
    const options = (await query("SELECT id::text AS id,title,text FROM canned_replies WHERE tenant_id=$1 ORDER BY shortcut LIMIT 25", [tenant.id])).rows
      // a saved reply with a [blank] to fill in is not ready to send as it is
      .filter((r) => !/\[[^\]\n]+\]/.test(r.text));
    if (!options.length) return await finish(logId, "skipped", { reason: "no saved reply is ready to send" }), "skipped";
    const choice = await chooseSavedReply({ tenant, conversationId: chat.id, options });
    if (!choice.replyId) return await finish(logId, "skipped", { reason: "no saved reply fits" }), "skipped";
    if (!choice.confident) return await finish(logId, "skipped", { reason: "not sure enough" }), "skipped";
    if (choice.tone === "frustrated" || choice.tone === "urgent") return await finish(logId, "skipped", { reason: `the customer sounds ${choice.tone}` }), "skipped";
    const reply = options.find((o) => o.id === choice.replyId);
    const text = personalise(reply.text, { name: chat.contact_name, company: tenant.name, spintax: false });
    const sent = await sendTextMessage({
      tenantId: tenant.id,
      conversationId: chat.id,
      text: withDisclosure(text),
      idempotencyKey: `autopilot:${chat.message_id}`.slice(0, 128),
      agentName: "Riwo",
      io,
      audit: { source: "autopilot", ruleRef: "saved_replies", triggerMessageId: chat.message_id, provider: choice.provider, model: choice.model, reversible: true },
    });
    await finish(logId, "sent", { reason: reply.title, text, replyMessageId: sent.message.id });
    emitForConversation(io, tenant.id, chat.id, "home:changed", { conversationId: chat.id });
    return "sent";
  } catch (error) {
    await finish(logId, "skipped", { reason: "Riwo could not be asked just now" }).catch(() => {});
    return "skipped";
  }
}

let lastRun = 0;
export async function pumpAutopilot(io, { force = false } = {}) {
  if (!force && Date.now() - lastRun < AUTOPILOT.everyMs) return 0;
  lastRun = Date.now();
  const tenants = (
    await query(
      `SELECT t.* FROM tenants t WHERE EXISTS (SELECT 1 FROM autopilot_rules r WHERE r.tenant_id=t.id AND r.enabled)
         AND EXISTS (SELECT 1 FROM conversations c WHERE c.tenant_id=t.id AND c.awaiting_since IS NOT NULL AND NOT c.is_closed AND NOT c.is_group) LIMIT 40`,
    )
  ).rows;
  let acted = 0;
  for (const tenant of tenants) {
    const rules = await rulesOf(tenant.id);
    // clearing a thank-you needs no AI, so it still works when Riwo is off for the company; replying needs Riwo
    const canAsk = unavailableReason(tenant) === null;
    const usage = canAsk ? await usageOf(tenant) : null;
    const effective = { thanks_done: rules.thanks_done, saved_replies: rules.saved_replies && canAsk && usage.used < usage.limit * 0.9 };
    for (const chat of await candidates(tenant.id)) {
      const result = await handle(tenant, effective, chat, io);
      if (result === "sent" || result === "cleared") acted += 1;
    }
  }
  return acted;
}

// What Autopilot did, newest first, for the chats this person may open.
export async function logFor(req, limit = 20) {
  const params = [req.tenantId, Math.min(Math.max(Number(limit) || 20, 1), 50)];
  let visible = "";
  if (!isManager(req)) {
    params.push(req.user.id);
    visible = ` AND (c.assigned_user_id=$3 OR c.session_name IN (SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 AND owner_user_id=$3))`;
  }
  const { rows } = await query(
    `SELECT l.id,l.rule_key,l.outcome,l.reason,l.text,l.reply_message_id,l.created_at,c.id AS conversation_id,c.contact_name,c.phone
       FROM autopilot_log l JOIN conversations c ON c.id=l.conversation_id AND c.tenant_id=l.tenant_id
      WHERE l.tenant_id=$1 AND l.outcome IN ('sent','cleared','undone')${visible}
      ORDER BY l.created_at DESC LIMIT $2`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    rule: r.rule_key,
    outcome: r.outcome,
    what: r.outcome === "cleared" ? "Cleared a thank-you" : r.outcome === "undone" ? "Taken back" : `Sent “${r.reason}”`,
    text: r.text,
    conversationId: r.conversation_id,
    title: chatTitle(r.contact_name, r.phone),
    at: r.created_at,
    canUndo: r.outcome === "sent" || r.outcome === "cleared",
  }));
}

// Takes an action back: a thank-you goes back on the waiting list; a sent reply is deleted for everyone (when WhatsApp
// allows it) and the customer is waiting again.
export async function undo(req, logId, io = null) {
  const row = (await query("SELECT * FROM autopilot_log WHERE id=$1 AND tenant_id=$2", [logId, req.tenantId])).rows[0];
  if (!row) throw fail(404, "That action was not found.");
  await assertConversationAccess(req, row.conversation_id);
  if (row.outcome !== "sent" && row.outcome !== "cleared") throw fail(409, "That action cannot be taken back.");
  if (row.outcome === "sent" && row.reply_message_id) {
    // a reply that has not left yet would still go out after being "deleted": wait until it has
    const state = (await query("SELECT status FROM messages WHERE id=$1 AND tenant_id=$2", [row.reply_message_id, req.tenantId])).rows[0]?.status;
    if (state === "sending" || state === "dispatching") throw fail(409, "That reply is still being sent. Try again in a moment.");
    await deleteMessage({ tenantId: req.tenantId, conversationId: row.conversation_id, messageId: row.reply_message_id, forEveryone: true, userId: req.user.id ?? null, io });
  }
  // back on the list, unless a person has dealt with the customer in the meantime
  await query(
    `UPDATE conversations SET awaiting_since=COALESCE(awaiting_since,$3), updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id=$2 AND m.conversation_id=$1 AND m.sender='agent' AND m.type<>'internal_note' AND ${HUMAN} AND m.created_at > $4)`,
    [row.conversation_id, req.tenantId, row.prior_awaiting_since, row.created_at],
  );
  await query("UPDATE autopilot_log SET outcome='undone', updated_at=now() WHERE id=$1", [logId]);
  // taking it back is a new row in the audit record, naming the action it reverses and who did it
  const earlier = (await query("SELECT id FROM automation_audit WHERE tenant_id=$1 AND conversation_id=$2 AND message_id IS NOT DISTINCT FROM $3 AND event IN ('sent','cleared') ORDER BY id DESC LIMIT 1", [req.tenantId, row.conversation_id, row.reply_message_id])).rows[0];
  await recordAutomated({ tenantId: req.tenantId, conversationId: row.conversation_id, event: "undone", source: "autopilot", ruleRef: `${row.rule_key} (taken back by ${req.user?.name || "a teammate"})`, messageId: row.reply_message_id, text: row.text || "", undoes: earlier?.id ?? null }).catch((e) => console.error("Audit record failed:", e.message));
  emitForConversation(io, req.tenantId, row.conversation_id, "home:changed", { conversationId: row.conversation_id });
  return { id: logId, outcome: "undone" };
}
