import crypto from "node:crypto";
import express from "express";
import {
  authenticateToken,
  requireTenantContext,
  requireScope,
  requireWriteAccess,
} from "../middleware/auth.js";
import { route, fail, text } from "../middleware/http.js";
import { query } from "../db/index.js";
import {
  validateMedia,
  uploadUrl,
  verifyUpload,
  savePreview,
  mediaTypes,
} from "../services/mediaService.js";
import { assertConversationAccess } from "../services/access.js";
import { sendTextMessage } from "../services/messageService.js";
const router = express.Router();
router.use(authenticateToken, requireTenantContext, requireScope("inbox"));
router.use(requireWriteAccess);
router.post(
  "/prepare",
  route(async (req, res) => {
    const { conversationId, mimeType, byteSize } = req.body;
    validateMedia(mimeType, byteSize);
    const name = text(req.body.filename, "Filename", 255);
    await assertConversationAccess(req, conversationId);
    const id = crypto.randomUUID(),
      key = `${req.tenantId}/${id}`;
    const url = await uploadUrl(key, mimeType, byteSize);
    await query(
      "INSERT INTO attachments(id,tenant_id,conversation_id,storage_key,original_name,mime_type,byte_size) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, req.tenantId, conversationId, key, name, mimeType, byteSize],
    );
    res
      .status(201)
      .json({ status: "success", attachmentId: id, uploadUrl: url });
  }),
);
router.post(
  "/:id/send",
  route(async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM attachments WHERE id=$1 AND tenant_id=$2",
      [req.params.id, req.tenantId],
    );
    const a = rows[0];
    if (!a) throw fail(404, "Attachment not found");
    await assertConversationAccess(req, a.conversation_id);
    const preview = await savePreview(
      a.storage_key,
      await verifyUpload(a),
      a.mime_type,
    );
    await query(
      "UPDATE attachments SET upload_status='ready',thumb_key=$3,width=$4,height=$5 WHERE id=$1 AND tenant_id=$2",
      [a.id, req.tenantId, preview.thumb_key, preview.width, preview.height],
    );
    const result = await sendTextMessage({
      tenantId: req.tenantId,
      conversationId: a.conversation_id,
      text: req.body.caption || a.original_name,
      idempotencyKey: req.body.idempotencyKey,
      type: mediaTypes[a.mime_type],
      attachment: a,
      agentName: req.user.name,
      sentByUserId: req.user.id ?? null,
      io: req.app.get("io"),
    });
    res.status(201).json({ status: "success", ...result });
  }),
);
export default router;
