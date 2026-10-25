import express from "express";
import { authenticateToken, requireTenantContext, requireRole, requireWriteAccess } from "../middleware/auth.js";
import { route, fail } from "../middleware/http.js";
import { query } from "../db/index.js";
import { requireFeature } from "../services/plans.js";
import { assertConversationAccess, assertSessionAccess, isManager } from "../services/access.js";
import {
  addTask,
  applyPreset,
  board,
  createLead,
  createLeadFromChat,
  deleteLead,
  dueTasks,
  findLead,
  findTask,
  leadForChat,
  leadView,
  listLeads,
  moveLead,
  saveStages,
  setAutoCreate,
  setCurrency,
  settings,
  taskView,
  tasksOf,
  patchTask,
  chatTasks,
  addChatTask,
  timeline,
  updateLead,
} from "../services/leadService.js";

const router = express.Router();
router.use(authenticateToken, requireTenantContext, (req, res, next) =>
  req.apiKey ? next(fail(403, "Interactive workspace login required")) : next(),
  requireFeature("leads"),
  requireWriteAccess,
);
const manager = requireRole("owner", "admin");
const io = (req) => req.app.get("io");

const filtersOf = (req) => ({
  ownerId: req.query.mine ? req.user.id : req.query.owner,
  sessionName: req.query.number,
  source: req.query.source,
  q: req.query.q,
  overdue: req.query.overdue === "1",
  stageId: req.query.stage,
  status: req.query.status,
  limit: req.query.limit,
  offset: req.query.offset,
});

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────
router.get("/settings", route(async (req, res) => res.json({ status: "success", ...(await settings(req.tenantId)) })));
router.put(
  "/settings/stages",
  manager,
  route(async (req, res) => {
    await saveStages(req.tenantId, req.body);
    res.json({ status: "success", ...(await settings(req.tenantId)) });
  }),
);
router.post(
  "/settings/preset",
  manager,
  route(async (req, res) => {
    await applyPreset(req.tenantId, req.body.preset);
    res.json({ status: "success", ...(await settings(req.tenantId)) });
  }),
);
router.put(
  "/settings/currency",
  manager,
  route(async (req, res) => {
    await setCurrency(req.tenantId, req.body.currency);
    res.json({ status: "success", ...(await settings(req.tenantId)) });
  }),
);
router.put(
  "/settings/auto-create",
  manager,
  route(async (req, res) => {
    if (typeof req.body.enabled !== "boolean") throw fail(400, "enabled must be true or false");
    await setAutoCreate(req.tenantId, req.body.enabled);
    res.json({ status: "success", ...(await settings(req.tenantId)) });
  }),
);

// ── Board, list, follow-ups ──────────────────────────────────────────────────────────────────────
router.get("/board", route(async (req, res) => res.json({ status: "success", ...(await board(req, filtersOf(req))) })));
router.get("/", route(async (req, res) => res.json({ status: "success", ...(await listLeads(req, filtersOf(req))) })));
router.get(
  "/tasks",
  route(async (req, res) => {
    const when = ["today", "overdue", "all"].includes(req.query.when) ? req.query.when : "today";
    const tasks = await dueTasks(req, { when, everyone: req.query.everyone === "1", until: req.query.until });
    res.json({ status: "success", tasks });
  }),
);
router.patch(
  "/tasks/:taskId",
  route(async (req, res) => {
    const task = await findTask(req, req.params.taskId);
    const updated = await patchTask(req, task, req.body || {});
    res.json({ status: "success", task: taskView(updated) });
  }),
);
// Follow-ups on one chat (its own and its lead's), and a new one for a chat with no lead.
router.get(
  "/chat/:conversationId/tasks",
  route(async (req, res) => {
    res.json({ status: "success", tasks: await chatTasks(req, req.params.conversationId) });
  }),
);
router.post(
  "/chat/:conversationId/tasks",
  route(async (req, res) => {
    await addChatTask(req, { ...req.body, conversationId: req.params.conversationId });
    res.status(201).json({ status: "success", tasks: await chatTasks(req, req.params.conversationId) });
  }),
);
router.delete(
  "/tasks/:taskId",
  route(async (req, res) => {
    const task = await findTask(req, req.params.taskId);
    await query("DELETE FROM lead_tasks WHERE id=$1 AND tenant_id=$2", [task.id, req.tenantId]);
    res.json({ status: "success" });
  }),
);

// ── Leads ────────────────────────────────────────────────────────────────────────────────────────
// A lead is made from a chat (its number and its assignee come along) or from a contact.
async function contactFor(req, body) {
  if (body.conversationId) {
    await assertConversationAccess(req, body.conversationId);
    const conv = (await query("SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2", [body.conversationId, req.tenantId])).rows[0];
    return { conversation: conv };
  }
  const contact = (await query("SELECT id,name,phone FROM contacts WHERE id=$1 AND tenant_id=$2", [String(body.contactId || ""), req.tenantId])).rows[0];
  if (!contact) throw fail(404, "Contact not found");
  let sessionName = body.sessionName || null;
  if (sessionName) await assertSessionAccess(req, sessionName);
  else {
    // the number this person most recently talked to them on, if this person can see it
    const params = [req.tenantId, contact.id];
    const mine = isManager(req) ? "" : (params.push(req.user.id), ` AND s.owner_user_id=$${params.length}`);
    const chat = (
      await query(
        `SELECT c.session_name FROM conversations c JOIN whatsapp_sessions s ON s.tenant_id=c.tenant_id AND s.session_name=c.session_name
         WHERE c.tenant_id=$1 AND c.contact_id=$2${mine} ORDER BY c.last_active_epoch DESC LIMIT 1`,
        params,
      )
    ).rows[0];
    sessionName = chat?.session_name || null;
  }
  return { contact, sessionName };
}

router.post(
  "/",
  route(async (req, res) => {
    const { conversation, contact, sessionName } = await contactFor(req, req.body);
    const common = { tenantId: req.tenantId, actor: req.user, title: req.body.title, value: req.body.value, stageId: req.body.stageId || undefined, source: "chat", io: io(req) };
    let made;
    if (conversation) {
      made = await createLeadFromChat({ ...common, conversation, ownerUserId: req.body.ownerUserId === undefined ? undefined : req.body.ownerUserId || null });
    } else {
      // staff who can't see the contact's number would lose sight of the lead they just made: it is theirs
      const ownerUserId = req.body.ownerUserId === undefined ? (isManager(req) || sessionName ? null : req.user.id) : req.body.ownerUserId || null;
      made = await createLead({ ...common, source: "manual", contact, sessionName, ownerUserId, expectedClose: req.body.expectedClose });
    }
    const lead = await findLead(req, made.id).catch(() => null);
    res.status(made.existing ? 200 : 201).json({ status: "success", existing: made.existing, lead: lead ? leadView(lead) : null });
  }),
);
router.post(
  "/bulk",
  manager,
  route(async (req, res) => {
    const ids = Array.isArray(req.body.contactIds) ? [...new Set(req.body.contactIds.map(String))] : [];
    if (!ids.length || ids.length > 200) throw fail(400, "Choose between 1 and 200 contacts");
    const contacts = (await query("SELECT id,name,phone FROM contacts WHERE tenant_id=$1 AND id=ANY($2::varchar[])", [req.tenantId, ids])).rows;
    let created = 0,
      skipped = 0;
    for (const contact of contacts) {
      const chat = (await query("SELECT session_name FROM conversations WHERE tenant_id=$1 AND contact_id=$2 ORDER BY last_active_epoch DESC LIMIT 1", [req.tenantId, contact.id])).rows[0];
      const made = await createLead({ tenantId: req.tenantId, actor: req.user, contact, sessionName: chat?.session_name || null, stageId: req.body.stageId || undefined, ownerUserId: req.body.ownerUserId || null, source: "manual", io: io(req) });
      made.existing ? skipped++ : created++;
    }
    res.status(201).json({ status: "success", created, skipped: skipped + (ids.length - contacts.length) });
  }),
);
router.get(
  "/chat/:conversationId",
  route(async (req, res) => {
    await assertConversationAccess(req, req.params.conversationId);
    const lead = await leadForChat(req, req.params.conversationId);
    res.json({ status: "success", lead: lead ? leadView(lead) : null });
  }),
);
router.get(
  "/:id",
  route(async (req, res) => {
    const lead = await findLead(req, req.params.id);
    res.json({ status: "success", lead: leadView(lead), tasks: await tasksOf(lead.id, req.tenantId), timeline: await timeline(lead.id, req.tenantId) });
  }),
);
router.patch(
  "/:id",
  route(async (req, res) => {
    const lead = await findLead(req, req.params.id);
    await updateLead(req, lead, req.body);
    res.json({ status: "success", lead: leadView(await findLead(req, lead.id)) });
  }),
);
router.post(
  "/:id/move",
  route(async (req, res) => {
    const lead = await findLead(req, req.params.id);
    await moveLead(req, lead, req.body);
    res.json({ status: "success", lead: leadView(await findLead(req, lead.id)) });
  }),
);
router.post(
  "/:id/tasks",
  route(async (req, res) => {
    const lead = await findLead(req, req.params.id);
    await addTask(req, lead, req.body);
    res.status(201).json({ status: "success", tasks: await tasksOf(lead.id, req.tenantId) });
  }),
);
router.delete(
  "/:id",
  manager,
  route(async (req, res) => {
    await findLead(req, req.params.id);
    await deleteLead(req.tenantId, req.params.id, io(req));
    res.json({ status: "success" });
  }),
);
export default router;
