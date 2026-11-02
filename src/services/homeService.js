import { query } from "../db/index.js";
import { isManager } from "./access.js";
import { dueTasks } from "./leadService.js";
import { numberHealth } from "./numberHealth.js";
import { formatConversation } from "./conversationFormat.js";
import { chatTitle, hideId } from "./personName.js";
import { latestBrief } from "./aiBriefService.js";

// What "Today" shows: what needs this person now, found with plain rules (no AI is asked, so it is quick and free), most
// urgent first. The same visibility rule as the inbox applies: managers see everything, staff only the chats of their own
// numbers and the chats assigned to them.

const MAX_ITEMS = 10;

// Chats where the customer wrote last and nobody on the team has answered, longest wait first.
async function waitingChats(req, now) {
  const params = [req.tenantId];
  let visible = "";
  if (!isManager(req)) {
    params.push(req.user.id);
    visible = ` AND (c.assigned_user_id=$2 OR c.session_name IN (SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 AND owner_user_id=$2))`;
  }
  const sla = (await query("SELECT sla_minutes FROM report_settings WHERE tenant_id=$1", [req.tenantId])).rows[0]?.sla_minutes ?? 30;
  const base = `FROM conversations c WHERE c.tenant_id=$1 AND c.awaiting_since IS NOT NULL AND NOT c.is_closed AND NOT c.is_group
    AND c.provider_chat_id !~ '@(broadcast|newsletter)$'${visible}`;
  const [{ rows }, totals] = await Promise.all([
    // Riwo's preparation is shown only while it is for the customer's latest message
    query(
      `SELECT c.*, i.summary AS ai_summary, i.mood AS ai_mood, i.mood_note AS ai_mood_note, i.next_step AS ai_next_step, i.draft AS ai_draft
         ${base.replace("FROM conversations c WHERE", `FROM conversations c LEFT JOIN ai_insights i ON i.conversation_id=c.id AND i.status='ready'
           AND i.based_on_message_id IS NOT DISTINCT FROM (SELECT m.id FROM messages m WHERE m.tenant_id=c.tenant_id AND m.conversation_id=c.id AND m.sender='customer' ORDER BY m.timestamp_epoch DESC, m.id DESC LIMIT 1) WHERE`)}
        ORDER BY c.awaiting_since ASC LIMIT ${MAX_ITEMS}`,
      params,
    ),
    query(`SELECT count(*)::int AS waiting, count(*) FILTER (WHERE c.awaiting_since < $${params.length + 1})::int AS overdue ${base}`, [...params, now - sla * 60]),
  ]);
  return {
    sla,
    waiting: totals.rows[0].waiting,
    overdue: totals.rows[0].overdue,
    items: rows.map((r) => {
      const chat = formatConversation(r);
      const waited = Math.max(0, now - Number(r.awaiting_since));
      const last = chat.lastMessage || {};
      return {
        kind: "chat",
        id: `chat:${r.id}`,
        conversationId: r.id,
        title: chat.contactName,
        avatar: chat.avatar,
        preview: last.fromMe ? "" : String(last.text || "").slice(0, 160),
        waitingSeconds: waited,
        overdue: waited > sla * 60,
        unread: chat.unreadCount,
        assignedTo: chat.assignedTo,
        isMine: r.assigned_user_id === req.user.id,
        prep: r.ai_summary || r.ai_draft ? { summary: r.ai_summary, mood: r.ai_mood, moodNote: r.ai_mood_note, nextStep: r.ai_next_step, draft: r.ai_draft } : null,
      };
    }),
  };
}

// Follow-ups due by the end of the person's own day (their browser says when that is), overdue ones first.
async function followUps(req, until) {
  const tasks = await dueTasks(req, { when: "today", everyone: false, until });
  const now = Date.now();
  return tasks.slice(0, 50).map((t) => ({
    kind: "task",
    id: `task:${t.id}`,
    taskId: t.id,
    conversationId: t.conversationId || null,
    title: t.title,
    who: hideId(t.contactName || t.leadTitle || "", ""),
    dueAt: t.dueAt,
    overdue: new Date(t.dueAt).getTime() < now,
    escalated: Boolean(t.escalated),
  }));
}

async function numberProblems(req) {
  const rows = await numberHealth(req.tenantId, { ownerUserId: isManager(req) ? null : req.user.id });
  return rows
    .filter((n) => n.level === "down" || n.level === "warn" || n.level === "unpaired")
    .map((n) => ({
      kind: "number",
      id: `number:${n.sessionName}`,
      sessionName: n.sessionName,
      title: n.label,
      level: n.level,
      problem: n.problems?.[0]?.text || "This number needs attention.",
    }));
}

// First-run help for the owners and administrators of a workspace that is not set up yet.
async function setupSteps(req) {
  const { rows } = await query(
    `SELECT
      (SELECT count(*)::int FROM whatsapp_sessions WHERE tenant_id=$1 AND status='CONNECTED') AS connected,
      (SELECT count(*)::int FROM canned_replies WHERE tenant_id=$1) AS replies,
      (SELECT count(*)::int FROM memberships WHERE tenant_id=$1 AND status='active') AS people,
      (SELECT count(*)::int FROM automations WHERE tenant_id=$1) AS automations`,
    [req.tenantId],
  );
  const r = rows[0];
  const steps = [
    { key: "connect", label: "Connect your WhatsApp number", done: r.connected > 0 },
    { key: "replies", label: "Save a few quick replies", done: r.replies > 0 },
    { key: "automation", label: "Turn on a welcome message", done: r.automations > 0 },
    { key: "team", label: "Invite a teammate", done: r.people > 1 },
  ];
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
}

export async function homeFor(req, { until } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const manager = isManager(req);
  const [waiting, tasks, numbers, setup, brief] = await Promise.all([
    waitingChats(req, now),
    followUps(req, until),
    numberProblems(req),
    manager ? setupSteps(req) : Promise.resolve(null),
    manager ? latestBrief(req.tenantId) : Promise.resolve(null),
  ]);
  // most urgent first: customers past the reply target, a number that is down, late follow-ups, waiting customers, follow-ups later today
  const rank = (i) =>
    i.kind === "chat" ? (i.overdue ? 0 : 3) + (i.isMine ? 0 : 0.5) : i.kind === "number" ? (i.level === "down" || i.level === "unpaired" ? 1 : 4) : i.overdue ? 2 : 5;
  const items = [...waiting.items, ...tasks, ...numbers]
    .map((i, n) => ({ i, n }))
    .sort((a, b) => rank(a.i) - rank(b.i) || (a.i.kind === "chat" && b.i.kind === "chat" ? b.i.waitingSeconds - a.i.waitingSeconds : a.n - b.n))
    .map(({ i }) => i);
  return {
    generatedAt: new Date().toISOString(),
    firstName: String(req.user?.name || "").trim().split(/\s+/)[0] || "",
    counts: {
      waiting: waiting.waiting,
      overdue: waiting.overdue,
      tasksDue: tasks.length,
      tasksOverdue: tasks.filter((t) => t.overdue).length,
      numbersNeedingCare: numbers.length,
    },
    replyTargetMinutes: waiting.sla,
    needsYou: items.slice(0, MAX_ITEMS),
    more: Math.max(0, items.length - MAX_ITEMS),
    setup: setup && setup.done < setup.total ? setup : null,
    // the morning brief, for owners and administrators
    brief,
  };
}
