import express from "express";
import {
  authenticateToken,
  requireTenantContext,
  requireScope,
  requireWriteAccess,
} from "../middleware/auth.js";
import crypto from "node:crypto";
import { query } from "../db/index.js";
import { route, fail } from "../middleware/http.js";
import { defaultWhatsAppProvider as provider } from "../services/whatsapp/WhatsAppProvider.js";
import { formatConversation } from "../services/conversationService.js";
import { handleIncomingMessage } from "../services/messageService.js";
import {
  isManager,
  assertSessionAccess,
  assertConversationAccess,
} from "../services/access.js";
import { emitForConversation } from "../services/realtime.js";
import { sendMessageRateLimiter } from "../middleware/rateLimiter.js";
import {
  getConversations,
  markConversationRead,
  syncConversations,
} from "../services/conversationService.js";
import {
  getConversationMessages,
  sendTextMessage,
} from "../services/messageService.js";

const router = express.Router();

router.use(authenticateToken);
router.use(requireTenantContext);
router.use(requireScope("inbox"));
router.use(requireWriteAccess);

router.post(
  "/",
  route(async (req, res) => {
    const { contactId, channel, sessionName } = req.body;
    const contact = await query(
      "SELECT * FROM contacts WHERE id=$1 AND tenant_id=$2",
      [contactId, req.tenantId],
    );
    if (!contact.rows[0]) throw fail(404, "Contact not found");
    const name = sessionName || channel;
    await assertSessionAccess(req, name);
    const c = contact.rows[0],
      jid = c.phone.includes("@")
        ? c.phone
        : `${c.phone.replace(/\D/g, "")}@c.us`;
    const { rows } = await query(
      `INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,contact_id,phone,contact_name,avatar) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(tenant_id,session_name,provider_chat_id) DO UPDATE SET contact_id=EXCLUDED.contact_id RETURNING *`,
      [
        crypto.randomUUID(),
        req.tenantId,
        name,
        jid,
        c.id,
        c.phone,
        c.name,
        c.avatar,
      ],
    );
    res
      .status(201)
      .json({
        status: "success",
        chat: formatConversation(rows[0]),
        conversation: formatConversation(rows[0]),
      });
  }),
);
router.patch(
  "/:id",
  route(async (req, res) => {
    await assertConversationAccess(req, req.params.id);
    if (req.body.assignedTo) {
      const member = await query(
        `SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND u.name=$2`,
        [req.tenantId, req.body.assignedTo],
      );
      if (!member.rowCount)
        throw fail(400, "Assignee is not an active teammate");
    }
    const { rows } = await query(
      `UPDATE conversations SET assigned_to=COALESCE($1,assigned_to),is_closed=COALESCE($2,is_closed),tags=COALESCE($3,tags),updated_at=now() WHERE id=$4 AND tenant_id=$5 RETURNING *`,
      [
        req.body.assignedTo ?? null,
        req.body.isClosed ?? null,
        req.body.tags ? JSON.stringify(req.body.tags) : null,
        req.params.id,
        req.tenantId,
      ],
    );
    if (!rows[0]) throw fail(404, "Conversation not found");
    const conversation = formatConversation(rows[0]);
    emitForConversation(
      req.app.get("io"),
      req.tenantId,
      req.params.id,
      "conversation:updated",
      {
        conversationId: req.params.id,
        ...conversation,
      },
    );
    res.json({ status: "success", conversation });
  }),
);
router.post(
  "/:id/notes",
  route(async (req, res) => {
    await assertConversationAccess(req, req.params.id);
    res
      .status(201)
      .json({
        status: "success",
        ...(await sendTextMessage({
          tenantId: req.tenantId,
          conversationId: req.params.id,
          text: req.body.text,
          idempotencyKey: req.body.idempotencyKey,
          agentName: req.user.name,
          type: "internal_note",
          io: req.app.get("io"),
        })),
      });
  }),
);

/**
 * GET /api/conversations
 * Cursor-paginated conversations in active tenant
 */
router.get("/", async (req, res) => {
  try {
    const { limit, cursor, filter, search, sessionName } = req.query;
    const result = await getConversations({
      tenantId: req.tenantId,
      limit,
      cursor,
      filter,
      search,
      sessionName,
      ownerUserId: isManager(req) ? null : req.user.id,
    });
    res.json({ status: "success", ...result });
  } catch (err) {
    res.status(err.status||500).json({ status: "error", message: err.status?err.message:"This operation is currently unavailable" });
  }
});

/**
 * GET /api/conversations/:id/messages
 * Cursor-paginated message history
 */
router.get("/:id/messages", async (req, res) => {
  try {
    await assertConversationAccess(req, req.params.id);
    const { limit, cursor } = req.query;
    if (req.query.sync === "true") {
      const { rows } = await query(
        "SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2",
        [req.params.id, req.tenantId],
      );
      if (!rows[0]) throw fail(404, "Conversation not found");
      const messages = await provider.getHistory(
        req.tenantId,
        rows[0].session_name,
        rows[0].provider_chat_id,
      );
      for (const msg of messages)
        await handleIncomingMessage({
          tenantId: req.tenantId,
          sessionName: rows[0].session_name,
          msg,
          history: true,
        });
    }
    const result = await getConversationMessages({
      tenantId: req.tenantId,
      conversationId: req.params.id,
      limit,
      cursor,
    });
    res.json({ status: "success", ...result });
  } catch (err) {
    res.status(err.status||500).json({ status: "error", message: err.status?err.message:"This operation is currently unavailable" });
  }
});

/**
 * POST /api/conversations/:id/messages
 * Idempotent enqueue; uncertain provider dispatch is never automatically retried
 */
router.post("/:id/messages", sendMessageRateLimiter, async (req, res) => {
  try {
    await assertConversationAccess(req, req.params.id);
    if (req.body.isNote || (req.body.type && req.body.type !== "text"))
      throw fail(400, "Use the dedicated notes or attachments endpoint");
    const { text, idempotencyKey } = req.body;
    const io = req.app.get("io");

    const result = await sendTextMessage({
      tenantId: req.tenantId,
      conversationId: req.params.id,
      text,
      idempotencyKey,
      agentName: req.user.name || "Agent",
      io,
    });

    res.status(result.duplicate ? 200 : 201).json({
      status: "success",
      ...result,
    });
  } catch (err) {
    res
      .status(err.status || (err.message.includes("not found") ? 404 : 400))
      .json({
        status: "error",
        message: err.message,
      });
  }
});

/**
 * POST /api/conversations/:id/read
 * Mark conversation as read
 */
router.post("/:id/read", async (req, res) => {
  try {
    await assertConversationAccess(req, req.params.id);
    const io = req.app.get("io");
    const result = await markConversationRead({
      tenantId: req.tenantId,
      conversationId: req.params.id,
      io,
    });
    res.json({ status: "success", conversation: result });
  } catch (err) {
    res.status(err.status||500).json({ status: "error", message: err.status?err.message:"This operation is currently unavailable" });
  }
});

/**
 * POST /api/conversations/sync
 * Sync conversations from WhatsApp session
 */
router.post("/sync", async (req, res) => {
  try {
    const { sessionName } = req.body;
    if (!sessionName && !isManager(req))
      throw fail(400, "sessionName is required");
    if (sessionName) await assertSessionAccess(req, sessionName);
    const io = req.app.get("io");
    const result = await syncConversations({
      tenantId: req.tenantId,
      sessionName: sessionName || "primary-whatsapp",
      io,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status||500).json({ status: "error", message: err.status?err.message:"This operation is currently unavailable" });
  }
});

export default router;
