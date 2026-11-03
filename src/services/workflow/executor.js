import { query, withTransaction } from "../../db/index.js";
import { ENV } from "../../config/env.js";
import { personalise } from "../templating.js";
import { sendTextMessage } from "../messageService.js";
import { withDisclosure } from "../handoffService.js";
import { addContactTag } from "../labelService.js";
import { createNotifications } from "../notificationService.js";
import { sendWorkflowAlert } from "../mailer.js";
import { assignConversation } from "../assignmentService.js";
import { ensureLead, handOffToExecutive } from "../salesAssistant.js";
import { ensurePipeline, stagesOf, advanceLeadBySystem, addSystemTask } from "../leadService.js";
import { chatState, runAutoChatTurn } from "../autoChat.js";
import { withinHours } from "../automationRules.js";
import { Skipped, assertUnanswered, WORKFLOW_MESSAGES_PER_HOUR } from "../personGuard.js";
import { begin, resume, awaiting } from "./core.js";
import { classifyAnswer } from "./classify.js";

// Runs a workflow for one customer message. The core decides (see core.js); this file does what it decided: sends the words, puts
// the labels, tells the people, makes the lead and the follow-up, and remembers where the chat is.
//
// A turn is made safe to run twice, because a rule that failed is tried again:
//   1. what to do is worked out once and written down (`vars._run`, with the model's reading of the answer inside it),
//   2. each step is done and counted as it is done, so a second try carries on from the next one,
//   3. only then is the chat's place saved. Messages carry the execution's own key, so a repeat sends nothing twice.

const RIWO = "Riwo";
const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// The rule as the agent steps see it: the same row, with the step's own goal, playbook and limits.
const agentRuleOf = (rule, node) => ({
  ...rule,
  config: {
    ...rule.config,
    agent: { enabled: true, goal: node.goal, playbook: node.playbook, closeWith: node.closeWith, pricing: node.pricing },
    maxReplies: node.maxReplies,
  },
});

const savePlace = (state, patch) =>
  query("UPDATE automation_chats SET node=$4,vars=$5::jsonb,attempts=$6,updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3 AND status='active'", [
    state.tenant_id,
    state.conversation_id,
    state.automation_id,
    patch.node,
    JSON.stringify(patch.vars),
    patch.attempts,
  ]);

async function peopleFor(tenantId, conv, who) {
  if (who === "assignee" && conv.assigned_user_id) return [conv.assigned_user_id];
  return (await query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND status='active' AND role IN ('owner','admin')", [tenantId])).rows.map((r) => r.user_id);
}

async function recentAutomatic(message) {
  return (
    await query("SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND sender='agent' AND agent_name IN ('Riwo','Automation') AND created_at>now()-interval '1 hour'", [message.tenant_id, message.conversation_id])
  ).rows[0].n;
}

// ── doing one thing ──────────────────────────────────────────────────────────────────────────────
async function apply(action, index, c) {
  const { rule, message, conv, contact, tenant, execution, io } = c;
  const tenantId = message.tenant_id;
  const vars = { name: contact?.name || conv.contact_name, company: tenant.name };
  const words = (t) => personalise(String(t), vars);
  switch (action.do) {
    case "say": {
      await assertUnanswered(message);
      if ((await recentAutomatic(message)) >= WORKFLOW_MESSAGES_PER_HOUR) throw new Skipped("Too many automatic messages in this chat in the last hour");
      const text = words(action.text);
      await sendTextMessage({
        tenantId,
        conversationId: conv.id,
        text: action.disclose ? withDisclosure(text) : text,
        idempotencyKey: `automation:${execution.id}:wf${index}`,
        agentName: RIWO,
        io,
        audit: { source: "workflow", ruleRef: `workflow: rule ${rule.id}, step ${action.node}`, triggerMessageId: message.id },
      });
      return;
    }
    case "label":
      if (contact) await withTransaction((cx) => addContactTag(cx, tenantId, contact.id, action.add));
      return;
    case "notify": {
      const ids = await peopleFor(tenantId, conv, action.who);
      const title = words(action.title).slice(0, 150);
      const body = words(action.text).slice(0, 300);
      if (action.channels.includes("app"))
        await createNotifications({ io, tenantId, conversationId: conv.id, dedupeKey: `workflow:${execution.id}:${index}`, recipients: ids.map((userId) => ({ userId, type: "handoff" })), title, body }).catch((e) => console.error("Workflow notice failed:", e.message));
      if (action.channels.includes("email") && ids.length) {
        const people = (await query("SELECT name,email FROM users WHERE id=ANY($1::int[]) AND status='active'", [ids])).rows;
        for (const p of people) await sendWorkflowAlert({ to: p.email, name: p.name, title, body, link: ENV.APP_URL }).catch((e) => console.error("Workflow e-mail failed:", e.message));
      }
      return;
    }
    case "assign": {
      const who = (await query("SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND u.name=$2 ORDER BY u.id LIMIT 1", [tenantId, action.teammate])).rows[0];
      if (!who) throw new Error(`${action.teammate} is not an active teammate any more`);
      await assignConversation({ tenantId, conversationId: conv.id, userId: who.id, io });
      return;
    }
    case "lead": {
      const leadId = await ensureLead({ tenantId, conv, name: contact?.name || conv.contact_name, requirements: [], io });
      if (action.stageName) {
        const pipeline = await ensurePipeline(tenantId);
        const stage = (await stagesOf(pipeline.id)).find((s) => s.kind === "open" && s.name.toLowerCase() === action.stageName.toLowerCase());
        if (stage) await advanceLeadBySystem({ tenantId, leadId, stageId: stage.id, actor: { id: null, name: RIWO }, io, detail: { reason: "a workflow step" } });
      }
      return;
    }
    case "task": {
      const fresh = (await query("SELECT assigned_user_id FROM conversations WHERE id=$1 AND tenant_id=$2", [conv.id, tenantId])).rows[0];
      await addSystemTask({ tenantId, conversationId: conv.id, title: words(action.title), dueAt: Date.now() + Math.max(0, Number(action.dueHours) || 0) * 3600_000, assignedUserId: fresh?.assigned_user_id || null, io });
      return;
    }
    case "handoff": {
      const state = await chatState(tenantId, conv.id, rule.id);
      await handOffToExecutive({ rule, state, conv, contact, execution, io, reason: action.reason, requirements: state?.requirements || [], company: tenant.name, lastText: message.text, since: message.timestamp_epoch });
      return;
    }
    case "end":
      await query(
        "UPDATE automation_chats SET status='handed_off',handed_off_reason=COALESCE(handed_off_reason,'The workflow finished'),outcome=COALESCE(outcome,$4),updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3 AND status='active'",
        [tenantId, conv.id, rule.id, action.outcome || "completed"],
      );
      return;
    default:
      throw new Error(`Unknown workflow action: ${action.do}`);
  }
}

// ── working out what to do ───────────────────────────────────────────────────────────────────────
async function contextOf({ message, contact }) {
  const tags = contact ? (await query("SELECT tags FROM contacts WHERE id=$1 AND tenant_id=$2", [contact.id, message.tenant_id])).rows[0]?.tags : [];
  return { labels: Array.isArray(tags) ? tags.map(String) : [], now: Number(message.timestamp_epoch) || Math.floor(Date.now() / 1000), withinHours };
}

async function plan({ rule, state, message, contact, tenant, mode }) {
  const flow = rule.config.workflow;
  const ctx = await contextOf({ message, contact });
  const { _run, ...vars } = state.vars || {}; // the last turn's written-down plan is not part of where the chat is
  void _run;
  const place = { node: state.node, vars, attempts: state.attempts || 0 };
  if (mode === "start" || !place.node) return begin(flow, ctx, { ...vars, last_message: clip(message.text, 300) });
  const node = awaiting(flow, place);
  if (node?.type === "agent") return { actions: [], state: place, pause: "agent", done: false, outcome: null };
  const input = { text: message.text };
  if (node?.type === "ask") input.choice = (await classifyAnswer({ tenant, node, text: message.text })).choice;
  return resume(flow, place, input, ctx);
}

// One turn of the workflow, for the message that began it ("start") or a later one ("continue").
export async function runWorkflow({ rule, message, conv, contact, tenant, execution, io, mode }) {
  const tenantId = message.tenant_id;
  const state = await chatState(tenantId, conv.id, rule.id);
  if (!state || state.status !== "active") throw new Skipped("The conversation had already been handed to a person");
  const c = { rule, message, conv, contact, tenant, execution, io };

  let saved = state.vars?._run?.exec === execution.id ? state.vars._run : null;
  if (!saved) {
    await assertUnanswered(message);
    const made = await plan({ rule, state, message, contact, tenant, mode });
    saved = { exec: execution.id, plan: made, applied: 0 };
    await query("UPDATE automation_chats SET vars=jsonb_set(vars,'{_run}',$4::jsonb,true),updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id, JSON.stringify(saved)]);
  }
  const made = saved.plan;
  for (let i = saved.applied; i < made.actions.length; i++) {
    await apply(made.actions[i], i, c);
    saved.applied = i + 1;
    await query("UPDATE automation_chats SET vars=jsonb_set(vars,'{_run,applied}',to_jsonb($4::int),true) WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id, saved.applied]);
  }

  // where the chat is now. The plan stays written down until the next turn replaces it, so a second try of this one (after a
  // failure further on) sees that everything is already done and only does what is left
  const vars = { ...made.state.vars, _run: { ...saved, applied: made.actions.length } };
  if (!made.done) await savePlace(state, { node: made.state.node, vars, attempts: made.state.attempts || 0 });
  else await query("UPDATE automation_chats SET vars=$4::jsonb WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id, JSON.stringify(vars)]);

  // Riwo's own turn, for an agent step: it answers from the knowledge base and hands over when the customer is ready
  if (made.pause === "agent") {
    const node = awaiting(rule.config.workflow, { node: made.state.node });
    await runAutoChatTurn({ rule: agentRuleOf(rule, node), message, conv, contact, tenant, execution, io });
  }
}
