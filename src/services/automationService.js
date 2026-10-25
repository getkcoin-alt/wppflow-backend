import crypto from "node:crypto";
import { query } from "../db/index.js";
import { sendTextMessage } from "./messageService.js";
import { planAllows } from "./plans.js";
import { personalise } from "./templating.js";
import { createLeadFromChat } from "./leadService.js";
import { matchesKeywords, withinHours, sendsReply } from "./automationRules.js";

export const automationView = (a) => ({
  ...a,
  triggerType: a.trigger_type,
  triggerCondition: a.trigger_condition,
  actionType: a.action_type,
  actionSummary: a.action_summary,
  isEnabled: a.is_enabled,
  executionsCount: a.executions_count,
  config: a.config || {},
  templateId: a.template_id || null,
});

// More than this many automatic replies to one chat in an hour means two bots are talking to each other.
const REPLIES_PER_HOUR = 6;

// Permission and withdrawal first, then questions, then the "away" and "welcome" messages, so a customer who
// writes "price" after hours gets the price, and a new customer writing at night is told you are closed.
const order = (rule) =>
  rule.action_type === "opt_in" || rule.action_type === "opt_out" ? 0 : rule.trigger_type === "keyword" ? 1 : rule.trigger_type === "after_hours" ? 2 : 3;

async function isFirstMessage(message) {
  const { rows } = await query(
    `SELECT 1 FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND sender='customer' AND id<>$3
     AND (timestamp_epoch<$4 OR (timestamp_epoch=$4 AND id<$3)) LIMIT 1`,
    [message.tenant_id, message.conversation_id, message.id, message.timestamp_epoch],
  );
  return rows.length === 0;
}

async function triggered(rule, message) {
  if (rule.trigger_type === "keyword") return matchesKeywords(rule.trigger_condition, message.text, rule.config?.match);
  if (rule.trigger_type === "first_message") return isFirstMessage(message);
  if (rule.trigger_type === "after_hours") return Boolean(rule.config?.hours) && !withinHours(rule.config.hours, Number(message.timestamp_epoch) || Math.floor(Date.now() / 1000));
  return false;
}

// Has this rule already done its job for this customer recently?
async function coolingDown(rule, message) {
  const hours = Number(rule.config?.cooldownHours) || 0;
  if (!hours) return false;
  const { rows } = await query(
    `SELECT 1 FROM automation_executions e JOIN messages m ON m.id=e.message_id
     WHERE e.tenant_id=$1 AND e.automation_id=$2 AND e.status='completed' AND m.conversation_id=$3 AND m.id<>$4
     AND e.created_at > now() - make_interval(secs => $5::float8)  LIMIT 1`,
    [message.tenant_id, rule.id, message.conversation_id, message.id, hours * 3600],
  );
  return rows.length > 0;
}

async function tooManyReplies(message) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND sender='agent' AND agent_name='Automation' AND created_at > now() - interval '1 hour'`,
    [message.tenant_id, message.conversation_id],
  );
  return rows[0].n >= REPLIES_PER_HOUR;
}

// Does the action. Every step can safely run twice, because a failed rule is tried again.
async function perform(rule, { message, conv, contact, company, execution, io }) {
  const tenantId = message.tenant_id;
  const vars = { name: contact?.name || conv.contact_name, company };
  const say = (text, suffix = "") =>
    sendTextMessage({
      tenantId,
      conversationId: conv.id,
      text: personalise(text, vars),
      idempotencyKey: `automation:${execution.id}${suffix}`,
      agentName: "Automation",
      io,
    });
  switch (rule.action_type) {
    case "reply_text":
      await say(rule.action_summary);
      return;
    case "assign_agent": {
      const member = await query(
        "SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND u.name=$2",
        [tenantId, rule.action_summary],
      );
      if (!member.rowCount) throw new Error("Assigned teammate is unavailable");
      await query("UPDATE conversations SET assigned_to=$1 WHERE id=$2 AND tenant_id=$3", [rule.action_summary, conv.id, tenantId]);
      break;
    }
    case "add_tag":
      if (!contact) throw new Error("This chat has no contact to tag");
      await query(
        `UPDATE contacts SET tags=CASE WHEN COALESCE(tags,'[]'::jsonb) ? $3::text THEN tags ELSE COALESCE(tags,'[]'::jsonb) || to_jsonb($3::text) END,updated_at=now() WHERE id=$1 AND tenant_id=$2`,
        [contact.id, tenantId, rule.action_summary],
      );
      break;
    case "opt_in":
    case "opt_out": {
      if (!contact) throw new Error("This chat has no contact");
      const optIn = rule.action_type === "opt_in";
      // Only the permission for broadcasts changes. The chat stays open: staff can still talk to this customer.
      await query(
        `INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,$2,$3,'customer_message')
         ON CONFLICT(tenant_id,phone) DO UPDATE SET opt_in_status=EXCLUDED.opt_in_status,source='customer_message',consented_at=now()`,
        [tenantId, contact.phone, optIn],
      );
      break;
    }
    case "create_lead":
      // a person who already has an open lead keeps it: nothing is duplicated
      await createLeadFromChat({ tenantId, conversation: conv, source: "automation", io });
      break;
    default:
      throw new Error("Unsupported automation action");
  }
  if (rule.config?.reply) await say(rule.config.reply, ":reply");
}

export async function pumpAutomations(io) {
  const { rows: events } = await query(
    "SELECT * FROM outbox_events WHERE event_type='automation.incoming' AND status='pending' AND retry_at<=now() ORDER BY id LIMIT 25",
  );
  for (const event of events) {
    let failure = null;
    const { rows: messages } = await query(
      "SELECT * FROM messages WHERE id=$1 AND tenant_id=$2 AND sender='customer'",
      [event.aggregate_id, event.tenant_id],
    );
    const message = messages[0];
    if (message) {
      const conv = (await query("SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2", [message.conversation_id, event.tenant_id])).rows[0];
      const tenant = (await query("SELECT plan,name,period_end,scheduled_plan FROM tenants WHERE id=$1", [event.tenant_id])).rows[0];
      // A company whose plan doesn't include automations keeps its rules but they don't run. A group chat is
      // never answered automatically: one reply would go to everyone in it.
      const rules =
        conv && !conv.is_group && tenant && planAllows(tenant, "automations")
          ? (await query("SELECT * FROM automations WHERE tenant_id=$1 AND is_enabled=true ORDER BY created_at, id", [event.tenant_id])).rows
          : [];
      rules.sort((a, b) => order(a) - order(b));
      const contact = conv?.contact_id
        ? (await query("SELECT id,name,phone FROM contacts WHERE id=$1 AND tenant_id=$2", [conv.contact_id, event.tenant_id])).rows[0]
        : null;
      let replied = false;
      for (const rule of rules) {
        if (!(await triggered(rule, message)) || (await coolingDown(rule, message))) continue;
        const id = crypto.randomUUID();
        await query(
          "INSERT INTO automation_executions(id,tenant_id,automation_id,message_id,status) VALUES($1,$2,$3,$4,'pending') ON CONFLICT DO NOTHING",
          [id, event.tenant_id, rule.id, message.id],
        );
        const { rows } = await query(
          "SELECT * FROM automation_executions WHERE tenant_id=$1 AND automation_id=$2 AND message_id=$3",
          [event.tenant_id, rule.id, message.id],
        );
        const execution = rows[0];
        if (execution.status === "completed") {
          replied ||= sendsReply(rule); // tried again after a failure: remember who has already answered
          continue;
        }
        if (execution.status === "skipped") continue;
        try {
          if (sendsReply(rule) && (replied || (await tooManyReplies(message)))) {
            await query("UPDATE automation_executions SET status='skipped',error=$1 WHERE id=$2 AND status<>'completed'", [
              replied ? "Another rule already replied to this message" : "Too many automatic replies to this chat in the last hour",
              execution.id,
            ]);
            continue;
          }
          await perform(rule, { message, conv, contact, company: tenant.name, execution, io });
          replied ||= sendsReply(rule);
          const done = await query(
            "UPDATE automation_executions SET status='completed',error=NULL WHERE id=$1 AND status<>'completed' RETURNING id",
            [execution.id],
          );
          if (done.rowCount)
            await query("UPDATE automations SET executions_count=executions_count+1 WHERE id=$1 AND tenant_id=$2", [rule.id, event.tenant_id]);
        } catch (error) {
          await query("UPDATE automation_executions SET status='failed',error=$1 WHERE id=$2 AND status<>'completed'", [error.message, execution.id]);
          failure = error.message;
        }
      }
    }
    await query(
      "UPDATE outbox_events SET status=$2::varchar,processed_at=CASE WHEN $2::varchar='processed' THEN now() ELSE NULL END,attempts=attempts+1,last_error=$3,retry_at=now()+interval '30 seconds' WHERE id=$1",
      [event.id, failure ? (event.attempts >= 4 ? "failed" : "pending") : "processed", failure],
    );
  }
}
