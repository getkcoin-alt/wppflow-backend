import crypto from "node:crypto";
import express from "express";
import {
  authenticateToken,
  requireTenantContext,
  requireScope,
  requireWriteAccess,
  requireRole,
} from "../middleware/auth.js";
import { audienceFor, recordPermission } from "../services/campaignService.js";
import { query, withTransaction } from "../db/index.js";
import { defaultWhatsAppProvider as provider } from "../services/whatsapp/WhatsAppProvider.js";
import { route, text, fail } from "../middleware/http.js";
const router = express.Router();
router.use(authenticateToken, requireTenantContext, requireScope("contacts"));
router.use(requireWriteAccess);
export const contactView = (c) => ({
  ...c,
  tags: Array.isArray(c.tags) ? c.tags : [],
  optIn: Boolean(c.opt_in_status),
  customTraits: c.custom_traits || {},
  assignedAgent: c.assigned_agent || "",
  lifetimeValue: null,
  storeConnected: false,
  orders: [],
  notes: [],
  channel: null,
  lastSeen: null,
  createdAt: c.created_at,
});
export async function syncContacts(tenantId, sessionName) {
  const contacts = await provider.getContacts(tenantId, sessionName);
  const byPhone = new Map();
  for (const c of contacts) {
    const phone = String(c.id?._serialized || c.id || "").replace(
      /@c\.us$/,
      "",
    );
    if (!phone || phone.endsWith("@g.us")) continue;
    byPhone.set(phone, {
      phone,
      name: c.name || c.pushname || c.verifiedName || phone,
      avatar: c.profilePicThumbObj?.eurl || "",
    });
  }
  // One statement per 500 contacts instead of one per contact.
  const all = [...byPhone.values()];
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    await query(
      `INSERT INTO contacts(id,tenant_id,name,phone,avatar)
       SELECT gen_random_uuid()::text,$1,x.name,x.phone,x.avatar FROM unnest($2::text[],$3::text[],$4::text[]) AS x(name,phone,avatar)
       ON CONFLICT(tenant_id,phone) DO UPDATE SET name=EXCLUDED.name,avatar=COALESCE(NULLIF(EXCLUDED.avatar,''),contacts.avatar),updated_at=now()`,
      [
        tenantId,
        chunk.map((c) => c.name),
        chunk.map((c) => c.phone),
        chunk.map((c) => c.avatar),
      ],
    );
  }
  return all.length;
}
router.get(
  "/",
  route(async (req, res) => {
    const params = [req.tenantId],
      filters = [];
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    if (req.query.cursor) {
      params.push(String(req.query.cursor));
      filters.push(`id>$${params.length}`);
    }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      filters.push(
        `(name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`,
      );
    }
    const { rows } = await query(
      `SELECT contacts.*,(SELECT opt_in_status FROM consents WHERE tenant_id=contacts.tenant_id AND phone=contacts.phone) AS opt_in_status FROM contacts WHERE tenant_id=$1${filters.length ? " AND " + filters.join(" AND ") : ""} ORDER BY id LIMIT $${params.length + 1}`,
      [...params, limit + 1],
    );
    const items = rows.slice(0, limit);
    res.json({
      status: "success",
      contacts: items.map(contactView),
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? items.at(-1).id : null,
    });
  }),
);
router.get(
  "/:id",
  route(async (req, res) => {
    const { rows } = await query(
      "SELECT contacts.*,(SELECT opt_in_status FROM consents WHERE tenant_id=contacts.tenant_id AND phone=contacts.phone) AS opt_in_status FROM contacts WHERE tenant_id=$1 AND id=$2",
      [req.tenantId, req.params.id],
    );
    if (!rows[0]) throw fail(404, "Contact not found");
    res.json({ status: "success", contact: contactView(rows[0]) });
  }),
);
// The owner confirms that the people in a group agreed to hear from the business. It only covers contacts nobody
// has decided on: someone who said STOP, or was marked as not wanting messages, is left alone.
router.post(
  "/permission",
  requireRole("owner", "admin"),
  route(async (req, res) => {
    if (req.body.confirm !== true) throw fail(400, "Confirm that these contacts agreed to receive your messages");
    const tag = req.body.tag ? text(String(req.body.tag), "Tag", 255) : "All Contacts";
    const recorded = await recordPermission(req.tenantId, tag, req.user.id);
    res.json({ status: "success", recorded, audience: await audienceFor(req.tenantId, tag) });
  }),
);
router.post(
  "/import",
  route(async (req, res) => {
    const rows = req.body.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > 200)
      throw fail(400, "Import 1–200 rows per batch");
    await withTransaction(async (c) => {
      for (const row of rows) {
        const name = text(row.name, "Name", 255),
          phone = text(row.phone, "Phone", 128);
        await c.query(
          // A file without tags must not wipe the tags a contact already has.
          `INSERT INTO contacts(id,tenant_id,name,phone,email,tags) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,phone) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,tags=CASE WHEN jsonb_array_length(EXCLUDED.tags)>0 THEN EXCLUDED.tags ELSE contacts.tags END,updated_at=now()`,
          [
            crypto.randomUUID(),
            req.tenantId,
            name,
            phone,
            row.email || "",
            JSON.stringify(
              String(row.tags || "")
                .split(";")
                .filter(Boolean),
            ),
          ],
        );
        // An "optin" column records permission. "yes" never overrides what a customer already decided (a
        // STOP stays a STOP); "no" always withdraws it.
        const said = String(row.optin ?? "").trim().toLowerCase();
        if (["yes", "y", "true", "1"].includes(said))
          await c.query(
            "INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,$2,true,'csv_import') ON CONFLICT(tenant_id,phone) DO NOTHING",
            [req.tenantId, phone],
          );
        else if (["no", "n", "false", "0"].includes(said))
          await c.query(
            "INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,$2,false,'csv_import') ON CONFLICT(tenant_id,phone) DO UPDATE SET opt_in_status=false,source='csv_import',consented_at=now()",
            [req.tenantId, phone],
          );
      }
    });
    res.json({ status: "success", imported: rows.length });
  }),
);
router.post(
  "/",
  route(async (req, res) => {
    const name = text(req.body.name, "Name", 255),
      phone = text(req.body.phone, "Phone", 128);
    const { rows } = await query(
      `INSERT INTO contacts(id,tenant_id,name,phone,email,tags,custom_traits) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,phone) DO UPDATE SET name=EXCLUDED.name,updated_at=now() RETURNING *`,
      [
        crypto.randomUUID(),
        req.tenantId,
        name,
        phone,
        req.body.email || "",
        JSON.stringify(req.body.tags || []),
        JSON.stringify(req.body.customTraits || {}),
      ],
    );
    res.status(201).json({ status: "success", contact: contactView(rows[0]) });
  }),
);
router.patch(
  "/:id",
  route(async (req, res) => {
    if (
      req.body.tags &&
      (!Array.isArray(req.body.tags) ||
        req.body.tags.some((t) => typeof t !== "string"))
    )
      throw fail(400, "Tags must be an array of strings");
    const contact = await withTransaction(async (c) => {
      const { rows } = await c.query(
        `UPDATE contacts SET name=COALESCE($1,name),email=COALESCE($2,email),tags=COALESCE($3,tags),custom_traits=COALESCE($4,custom_traits),updated_at=now() WHERE id=$5 AND tenant_id=$6 RETURNING *`,
        [
          req.body.name || null,
          req.body.email ?? null,
          req.body.tags ? JSON.stringify(req.body.tags) : null,
          req.body.customTraits ? JSON.stringify(req.body.customTraits) : null,
          req.params.id,
          req.tenantId,
        ],
      );
      if (!rows[0]) throw fail(404, "Contact not found");
      if (typeof req.body.optIn === "boolean")
        await c.query(
          `INSERT INTO consents(tenant_id,phone,opt_in_status,source) VALUES($1,$2,$3,'workspace_recorded') ON CONFLICT(tenant_id,phone) DO UPDATE SET opt_in_status=EXCLUDED.opt_in_status,consented_at=now()`,
          [req.tenantId, rows[0].phone, req.body.optIn],
        );
      const consent = await c.query(
        "SELECT opt_in_status FROM consents WHERE tenant_id=$1 AND phone=$2",
        [req.tenantId, rows[0].phone],
      );
      return contactView({
        ...rows[0],
        opt_in_status: consent.rows[0]?.opt_in_status,
      });
    });
    req.app
      .get("io")
      ?.to(`tenant:${req.tenantId}`)
      .emit("contact:changed", { contactId: contact.id });
    res.json({ status: "success", contact });
  }),
);
router.delete(
  "/:id",
  route(async (req, res) => {
    await query("DELETE FROM contacts WHERE id=$1 AND tenant_id=$2", [
      req.params.id,
      req.tenantId,
    ]);
    res.json({ status: "success" });
  }),
);
export default router;
