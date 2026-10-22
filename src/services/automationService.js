import crypto from "node:crypto";
import { query } from "../db/index.js";
import { sendTextMessage } from "./messageService.js";
import { planAllows } from "./plans.js";
export const automationView = (a) => ({
  ...a,
  triggerType: a.trigger_type,
  triggerCondition: a.trigger_condition,
  actionType: a.action_type,
  actionSummary: a.action_summary,
  isEnabled: a.is_enabled,
  executionsCount: a.executions_count,
});
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
      // A company whose plan doesn't include automations keeps its rules but they don't run.
      const plan = (await query("SELECT plan FROM tenants WHERE id=$1", [event.tenant_id])).rows[0]?.plan;
      const { rows: rules } = planAllows(plan, "automations")
        ? await query(
            "SELECT * FROM automations WHERE tenant_id=$1 AND is_enabled=true AND trigger_type='keyword'",
            [event.tenant_id],
          )
        : { rows: [] };
      for (const rule of rules) {
        if (
          !rule.trigger_condition ||
          !message.text
            .toLowerCase()
            .includes(rule.trigger_condition.toLowerCase())
        )
          continue;
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
        if (execution.status === "completed") continue;
        try {
          if (rule.action_type === "reply_text")
            await sendTextMessage({
              tenantId: event.tenant_id,
              conversationId: message.conversation_id,
              text: rule.action_summary,
              idempotencyKey: `automation:${execution.id}`,
              agentName: "Automation",
              io,
            });
          else if (rule.action_type === "assign_agent") {
            const member = await query(
              "SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND u.name=$2",
              [event.tenant_id, rule.action_summary],
            );
            if (!member.rowCount)
              throw new Error("Assigned teammate is unavailable");
            await query(
              "UPDATE conversations SET assigned_to=$1 WHERE id=$2 AND tenant_id=$3",
              [rule.action_summary, message.conversation_id, event.tenant_id],
            );
          } else throw new Error("Unsupported automation action");
          const done = await query(
            "UPDATE automation_executions SET status='completed',error=NULL WHERE id=$1 AND status<>'completed' RETURNING id",
            [execution.id],
          );
          if (done.rowCount)
            await query(
              "UPDATE automations SET executions_count=executions_count+1 WHERE id=$1 AND tenant_id=$2",
              [rule.id, event.tenant_id],
            );
        } catch (error) {
          await query(
            "UPDATE automation_executions SET status='failed',error=$1 WHERE id=$2 AND status<>'completed'",
            [error.message, execution.id],
          );
          failure = error.message;
        }
      }
    }
    await query(
      "UPDATE outbox_events SET status=$2::varchar,processed_at=CASE WHEN $2::varchar='processed' THEN now() ELSE NULL END,attempts=attempts+1,last_error=$3,retry_at=now()+interval '30 seconds' WHERE id=$1",
      [
        event.id,
        failure ? (event.attempts >= 4 ? "failed" : "pending") : "processed",
        failure,
      ],
    );
  }
}
