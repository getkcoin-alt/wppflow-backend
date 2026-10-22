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
import { fetchMessageMedia, fetchPendingMedia } from "../services/mediaFetchService.js";
import {
  isManager,
  assertSessionAccess,
  assertConversationAccess,
} from "../services/access.js";
import { emitForConversation } from "../services/realtime.js";
import { notifyAssignment, notifyInternalNote } from "../services/notificationService.js";
import { sendMessageRateLimiter } from "../middleware/rateLimiter.js";
import {
  getConversations,
  getConversationChanges,
  markConversationRead,
  syncConversations,
} from "../services/conversationService.js";
import {
  getConversationMessages,
  adoptMisfiledMessages,
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
    const before = await assertConversationAccess(req, req.params.id);
    // Assignment names a teammate (by id when the client knows it, else by name). Assigning
    // a chat also lets that teammate open it, so it must be a real, active member.
    let assignedName = null,
      assignedUserId = null,
      assignmentChanges = false;
    if (req.body.assignedUserId !== undefined || req.body.assignedTo !== undefined) {
      assignmentChanges = true;
      const wantsId = req.body.assignedUserId;
      const wantsName = req.body.assignedTo;
      if (wantsId || wantsName) {
        const member = await query(
          `SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id
           WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active'
             AND ${wantsId ? "u.id=$2" : "u.name=$2"} ORDER BY u.id LIMIT 1`,
          [req.tenantId, wantsId ? Number(wantsId) || 0 : wantsName],
        );
        if (!member.rowCount)
          throw fail(400, "Assignee is not an active teammate");
        assignedName = member.rows[0].name;
        assignedUserId = member.rows[0].id;
      } else {
        assignedName = ""; // unassign
      }
    }
    const { rows } = await query(
      `UPDATE conversations SET assigned_to=COALESCE($1,assigned_to),assigned_user_id=CASE WHEN $6::boolean THEN $7::int ELSE assigned_user_id END,
       is_closed=COALESCE($2,is_closed),tags=COALESCE($3,tags),updated_at=now() WHERE id=$4 AND tenant_id=$5 RETURNING *`,
      [
        assignedName,
        req.body.isClosed ?? null,
        req.body.tags ? JSON.stringify(req.body.tags) : null,
        req.params.id,
        req.tenantId,
        assignmentChanges,
        assignedUserId,
      ],
    );
    if (!rows[0]) throw fail(404, "Conversation not found");
    if (assignmentChanges && assignedUserId && assignedUserId !== before.assigned_user_id)
      notifyAssignment({
        io: req.app.get("io"),
        tenantId: req.tenantId,
        conversationId: req.params.id,
        actor: req.user,
        assigneeId: assignedUserId,
      }).catch((e) => console.error("Assignment notification failed:", e.message));
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
      { snapshot: true },
    );
    res.json({ status: "success", conversation });
  }),
);
router.post(
  "/:id/notes",
  route(async (req, res) => {
    await assertConversationAccess(req, req.params.id);
    const result = await sendTextMessage({
      tenantId: req.tenantId,
      conversationId: req.params.id,
      text: req.body.text,
      idempotencyKey: req.body.idempotencyKey,
      agentName: req.user.name,
      type: "internal_note",
      io: req.app.get("io"),
    });
    if (!result.duplicate)
      notifyInternalNote({
        io: req.app.get("io"),
        tenantId: req.tenantId,
        conversationId: req.params.id,
        messageId: result.message?.id,
        actor: req.user,
        text: req.body.text,
      }).catch((e) => console.error("Note notification failed:", e.message));
    res.status(201).json({ status: "success", ...result });
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
 * GET /api/conversations/changes?since=ISO
 * Conversations changed after a point in time (reconnect / wake-up catch-up)
 */
router.get(
  "/changes",
  route(async (req, res) => {
    const result = await getConversationChanges({
      tenantId: req.tenantId,
      ownerUserId: isManager(req) ? null : req.user.id,
      since: req.query.since,
      limit: req.query.limit,
    });
    res.json({ status: "success", ...result });
  }),
);

/**
 * GET /api/conversations/:id  (open a chat from a notification or link)
 */
router.get(
  "/:id",
  route(async (req, res) => {
    await assertConversationAccess(req, req.params.id);
    const { rows } = await query(
      "SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2",
      [req.params.id, req.tenantId],
    );
    if (!rows[0]) throw fail(404, "Conversation not found");
    const conversation = formatConversation(rows[0]);
    res.json({ status: "success", conversation, chat: conversation });
  }),
);

/**
 * GET /api/conversations/:id/messages
 * Cursor-paginated message history
 */
router.get("/:id/messages", async (req, res) => {
  try {
    await assertConversationAccess(req, req.params.id);
    const { limit, cursor } = req.query;
    let historySync;
    if (req.query.sync === "true") {
      const { rows } = await query(
        "SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2",
        [req.params.id, req.tenantId],
      );
      if (!rows[0]) throw fail(404, "Conversation not found");
      // Older history is a bonus: if WhatsApp is unreachable, show what we already have,
      // and say why so the screen can explain an empty chat.
      try {
        const messages = await provider.getHistory(
          req.tenantId,
          rows[0].session_name,
          rows[0].provider_chat_id,
        );
        let stored = await adoptMisfiledMessages({
          tenantId: req.tenantId,
          sessionName: rows[0].session_name,
          conversationId: rows[0].id,
          providerMessageIds: messages.map((m) => m.providerMessageId),
        });
        for (const msg of messages)
          if (
            await handleIncomingMessage({
              tenantId: req.tenantId,
              sessionName: rows[0].session_name,
              msg,
              history: true,
            })
          )
            stored++;
        historySync = { fetched: messages.length, stored };
      } catch (error) {
        console.warn(`History sync skipped: ${error.message}`);
        historySync = {
          fetched: 0,
          stored: 0,
          error: String(error.message || "unavailable").slice(0, 160),
        };
      }
    }
    const result = await getConversationMessages({
      tenantId: req.tenantId,
      conversationId: req.params.id,
      limit,
      cursor,
    });
    res.json({
      status: "success",
      ...result,
      ...(historySync ? { historySync } : {}),
    });
  } catch (err) {
    res.status(err.status||500).json({ status: "error", message: err.status?err.message:"This operation is currently unavailable" });
  }
});

/**
 * POST /api/conversations/:id/messages/:messageId/media
 * Loads one file that was never saved from WhatsApp and keeps it
 */
const mediaFailure = (res, err) => {
  if (!err.status) console.error("Media request failed:", err.stack || err.message);
  res.status(err.status || 500).json({
    status: "error",
    message: err.status ? err.message : "This operation is currently unavailable",
  });
};
router.post("/:id/messages/:messageId/media", async (req, res) => {
  try {
    await assertConversationAccess(req, req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.messageId))
      throw fail(404, "Message not found");
    const message = await fetchMessageMedia({
      tenantId: req.tenantId,
      conversationId: req.params.id,
      messageId: req.params.messageId,
    });
    res.json({ status: "success", message });
  } catch (err) {
    mediaFailure(res, err);
  }
});

/**
 * POST /api/conversations/:id/media/fetch-pending
 * Loads a small batch of the chat's unsaved files; call again with nextBefore until it is null
 */
router.post("/:id/media/fetch-pending", async (req, res) => {
  try {
    await assertConversationAccess(req, req.params.id);
    res.json({
      status: "success",
      ...(await fetchPendingMedia({
        tenantId: req.tenantId,
        conversationId: req.params.id,
        limit: req.body?.limit,
        before: req.body?.before || null,
      })),
    });
  } catch (err) {
    mediaFailure(res, err);
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
