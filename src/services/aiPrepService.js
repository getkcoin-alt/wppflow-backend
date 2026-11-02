import { query } from "../db/index.js";
import { emitForConversation } from "./realtime.js";
import { prepareConversation, unavailableReason, usageOf } from "./aiService.js";

// While nobody is looking, Riwo gets the chats that are waiting ready: a summary, how the customer sounds and a reply to
// check. It costs the company's AI requests, so it is careful: only chats a customer is waiting on, only after they have
// waited a little (a person may be answering), once per customer message, a few at a time, and never when the company has
// used most of its day (that is kept for people asking Riwo themselves). A failure is remembered and tried again later.

export const PREP = { settleSeconds: 45, perTenantPerRun: 3, keepForPeople: 0.7, retryMinutes: 10, everyMs: 20_000 };
let lastRun = 0;

// Chats waiting on a customer whose latest message has not been prepared yet.
export async function candidates(tenantId, limit = PREP.perTenantPerRun, now = Math.floor(Date.now() / 1000)) {
  const { rows } = await query(
    `SELECT c.id, last.id AS message_id
       FROM conversations c
       JOIN LATERAL (SELECT m.id FROM messages m WHERE m.tenant_id=c.tenant_id AND m.conversation_id=c.id AND m.sender='customer'
                      ORDER BY m.timestamp_epoch DESC, m.id DESC LIMIT 1) last ON true
       LEFT JOIN ai_insights i ON i.conversation_id=c.id
      WHERE c.tenant_id=$1 AND c.awaiting_since IS NOT NULL AND NOT c.is_closed AND NOT c.is_group
        AND c.provider_chat_id !~ '@(broadcast|newsletter)$'
        AND c.awaiting_since < $2
        AND NOT EXISTS (SELECT 1 FROM automation_chats a WHERE a.tenant_id=c.tenant_id AND a.conversation_id=c.id AND a.status='active')
        AND (i.conversation_id IS NULL
             OR (i.based_on_message_id IS DISTINCT FROM last.id AND (i.status<>'working' OR i.updated_at < now()-interval '2 minutes'))
             OR (i.status='failed' AND i.based_on_message_id=last.id AND i.retry_at <= now()))
      ORDER BY c.awaiting_since ASC LIMIT $3`,
    [tenantId, now - PREP.settleSeconds, limit],
  );
  return rows;
}

// Takes the chat for this message, so two servers never prepare the same one.
async function claim(tenantId, conversationId, messageId) {
  const { rowCount } = await query(
    `INSERT INTO ai_insights(conversation_id,tenant_id,based_on_message_id,status) VALUES($1,$2,$3,'working')
     ON CONFLICT (conversation_id) DO UPDATE SET based_on_message_id=$3, status='working', error='', retry_at=NULL, updated_at=now()
     WHERE ai_insights.based_on_message_id IS DISTINCT FROM $3
        OR (ai_insights.status='failed' AND ai_insights.retry_at <= now())
        OR (ai_insights.status='working' AND ai_insights.updated_at < now()-interval '2 minutes')`,
    [conversationId, tenantId, messageId],
  );
  return rowCount > 0;
}

export async function prepareOne(tenant, { id, message_id: messageId }, io = null) {
  if (!(await claim(tenant.id, id, messageId))) return false;
  try {
    const out = await prepareConversation({ tenant, conversationId: id });
    // the customer may have written again while Riwo was working: then this is already out of date
    await query(
      `UPDATE ai_insights SET status='ready', summary=$2, mood=$3, mood_note=$4, next_step=$5, draft=$6, provider=$7, model=$8, error='', updated_at=now()
        WHERE conversation_id=$1 AND based_on_message_id=$9`,
      [id, out.summary, out.mood, out.moodNote, out.nextStep, out.draft, out.provider || "", out.model || "", messageId],
    );
    emitForConversation(io, tenant.id, id, "home:changed", { conversationId: id });
    return true;
  } catch (error) {
    await query(
      `UPDATE ai_insights SET status='failed', error=$2, retry_at=now()+make_interval(mins=>$3), updated_at=now() WHERE conversation_id=$1 AND based_on_message_id=$4`,
      [id, String(error?.message || error).slice(0, 300), PREP.retryMinutes, messageId],
    );
    return false;
  }
}

export async function pumpAiPrep(io, { force = false } = {}) {
  if (!force && Date.now() - lastRun < PREP.everyMs) return 0;
  lastRun = Date.now();
  const tenants = (
    await query(
      `SELECT t.* FROM tenants t WHERE t.ai_enabled IS NOT FALSE AND t.ai_prepare
         AND EXISTS (SELECT 1 FROM conversations c WHERE c.tenant_id=t.id AND c.awaiting_since IS NOT NULL AND NOT c.is_closed AND NOT c.is_group)
       LIMIT 40`,
    )
  ).rows;
  let done = 0;
  for (const tenant of tenants) {
    if (unavailableReason(tenant) !== null) continue;
    const usage = await usageOf(tenant);
    if (usage.used >= usage.limit * PREP.keepForPeople) continue;
    for (const chat of await candidates(tenant.id)) if (await prepareOne(tenant, chat, io)) done += 1;
  }
  return done;
}
