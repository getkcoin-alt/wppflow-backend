import { query, withTransaction } from "../db/index.js";
import { fail } from "../middleware/http.js";
import { removeTenantSession } from "./sessionService.js";
import { deleteTenantMedia } from "./mediaService.js";

// Deleting a company, by the platform admin: everything of it goes, and one short record of the deletion stays.
//
// Never deleted: the company that runs the platform (migration 004), or any company the platform administrator is a member of; and
// any company with payments, invoices, refunds or auto-payment arrangements on record, because billing records have to be kept.
// Those can be suspended instead.

// The company that runs the platform itself.
const PLATFORM_COMPANY = "tenant_scriza";

// What a company has, in numbers: shown before it is deleted, and kept (as numbers only) in the record of the deletion.
export async function countsOf(tenantId) {
  const row = (
    await query(
      `SELECT
         (SELECT count(*) FROM memberships WHERE tenant_id=$1) AS people,
         (SELECT count(*) FROM whatsapp_sessions WHERE tenant_id=$1) AS numbers,
         (SELECT count(*) FROM whatsapp_sessions WHERE tenant_id=$1 AND status='CONNECTED') AS connected_numbers,
         (SELECT count(*) FROM contacts WHERE tenant_id=$1) AS contacts,
         (SELECT count(*) FROM conversations WHERE tenant_id=$1) AS conversations,
         (SELECT count(*) FROM messages WHERE tenant_id=$1) AS messages,
         (SELECT count(*) FROM attachments WHERE tenant_id=$1) AS files,
         (SELECT count(*) FROM campaigns WHERE tenant_id=$1) AS campaigns,
         (SELECT count(*) FROM automations WHERE tenant_id=$1) AS automations,
         (SELECT count(*) FROM leads WHERE tenant_id=$1) AS leads`,
      [tenantId],
    )
  ).rows[0];
  return {
    people: Number(row.people),
    numbers: Number(row.numbers),
    connectedNumbers: Number(row.connected_numbers),
    contacts: Number(row.contacts),
    conversations: Number(row.conversations),
    messages: Number(row.messages),
    files: Number(row.files),
    campaigns: Number(row.campaigns),
    automations: Number(row.automations),
    leads: Number(row.leads),
  };
}

// Why a company must not be deleted, in the platform admin's words. Empty means it can be.
export async function blockersOf(tenantId) {
  const blockers = [];
  const ours = await query("SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.is_superadmin LIMIT 1", [tenantId]);
  if (tenantId === PLATFORM_COMPANY || ours.rowCount) blockers.push("This is the company that runs the platform, or the platform administrator is in it. It cannot be deleted.");
  const money = (
    await query(
      `SELECT
         (SELECT count(*) FROM subscription_payments WHERE tenant_id=$1) AS recorded,
         (SELECT count(*) FROM payments WHERE tenant_id=$1) AS received,
         (SELECT count(*) FROM invoices WHERE tenant_id=$1) AS invoices,
         (SELECT count(*) FROM payment_refunds WHERE tenant_id=$1) AS refunds,
         (SELECT count(*) FROM autopay_subscriptions WHERE tenant_id=$1) AS autopay`,
      [tenantId],
    )
  ).rows[0];
  const parts = [];
  const add = (count, one, many) => Number(count) > 0 && parts.push(`${Number(count)} ${Number(count) === 1 ? one : many}`);
  add(money.recorded, "payment recorded by hand", "payments recorded by hand");
  add(money.received, "online payment", "online payments");
  add(money.invoices, "invoice", "invoices");
  add(money.refunds, "refund", "refunds");
  add(money.autopay, "auto-payment arrangement", "auto-payment arrangements");
  if (parts.length) blockers.push(`It has ${parts.join(", ")} on record. Billing records have to be kept, so this company can be suspended but not deleted.`);
  return blockers;
}

// What deleting a company would remove, and whether it may be deleted at all. Nothing is changed.
export async function deletionPreview(tenantId) {
  const company = (
    await query(
      `SELECT t.id,t.name,t.plan,t.status,t.created_at,o.name AS owner_name,o.email AS owner_email
         FROM tenants t
         LEFT JOIN LATERAL (SELECT u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=t.id AND m.role='owner' ORDER BY m.id LIMIT 1) o ON true
        WHERE t.id=$1`,
      [tenantId],
    )
  ).rows[0];
  if (!company) throw fail(404, "Company not found");
  const [counts, blockers] = await Promise.all([countsOf(tenantId), blockersOf(tenantId)]);
  return {
    company: { id: company.id, name: company.name, plan: company.plan, status: company.status, createdAt: company.created_at, owner: company.owner_email ? { name: company.owner_name, email: company.owner_email } : null },
    counts,
    blockers,
    canDelete: blockers.length === 0,
  };
}

const typedRight = (typed, name) => {
  const a = String(typed ?? "").trim().toLowerCase();
  return a !== "" && a === String(name ?? "").trim().toLowerCase();
};

// Tables that do not follow a company out when it is deleted, because they refer to it without cascading, in an order that respects
// what refers to what. Everything else (about sixty tables) goes with the company's own row.
const DOES_NOT_CASCADE = [
  "DELETE FROM webhook_deliveries WHERE tenant_id=$1",
  "DELETE FROM webhook_endpoints WHERE tenant_id=$1",
  "DELETE FROM automation_executions WHERE tenant_id=$1",
  "DELETE FROM api_keys WHERE tenant_id=$1",
  "DELETE FROM canned_replies WHERE tenant_id=$1",
  "DELETE FROM early_receipts WHERE tenant_id=$1",
  "DELETE FROM invitations WHERE tenant_id=$1",
  "DELETE FROM refresh_tokens WHERE tenant_id=$1",
];

// Deletes a company and everything of it, after the name has been typed. In order:
//   1. it is suspended and its live connections end, so nobody works in it meanwhile
//   2. its WhatsApp numbers are unlinked from the phones, stopped, and their saved logins deleted
//   3. its stored files are removed (if that fails, nothing else has been deleted yet and it can be tried again)
//   4. in one step: its records go, the people who belonged to no other company go, and the record of the deletion is kept
export async function deleteCompany({ tenantId, confirmName, actor, io = null }) {
  const preview = await deletionPreview(tenantId);
  if (!preview.canDelete) throw fail(409, preview.blockers[0]);
  const { company, counts } = preview;
  if (!typedRight(confirmName, company.name)) throw fail(400, `To delete ${company.name}, type its name exactly as shown.`);

  await query("UPDATE tenants SET status='suspended',updated_at=now() WHERE id=$1", [tenantId]);
  io?.in(`tenant:${tenantId}`).disconnectSockets();

  const numbersNotUnlinked = [];
  const sessions = (await query("SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY created_at", [tenantId])).rows;
  for (const { session_name: name } of sessions) {
    try {
      const { unlinked } = await removeTenantSession(tenantId, name, io, { cause: "company_deleted", actorId: actor?.id ?? null });
      if (!unlinked) numbersNotUnlinked.push(name);
    } catch (error) {
      // the number's records go with the company either way; the phone still shows it under Linked devices
      numbersNotUnlinked.push(name);
      console.error(`Company deletion: number ${name} was not stopped cleanly:`, error.message);
    }
  }

  let filesRemoved;
  try {
    filesRemoved = await deleteTenantMedia(tenantId);
  } catch (error) {
    throw fail(502, `The files of ${company.name} could not be removed from storage (${error.message}). Nothing else was deleted. Try again.`);
  }

  let peopleRemoved = 0;
  await withTransaction(async (c) => {
    const locked = (await c.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId])).rows[0];
    if (!locked) throw fail(404, "Company not found");
    // a payment can have been recorded since the preview
    const blockers = await blockersOf(tenantId);
    if (blockers.length) throw fail(409, blockers[0]);
    const members = (await c.query("SELECT user_id FROM memberships WHERE tenant_id=$1", [tenantId])).rows.map((r) => r.user_id);
    for (const sql of DOES_NOT_CASCADE) await c.query(sql, [tenantId]);
    await c.query(
      `INSERT INTO deleted_companies(tenant_id,name,plan,owner_name,owner_email,company_created_at,counts,deleted_by,deleted_by_email)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, company.name, company.plan, company.owner?.name ?? null, company.owner?.email ?? null, company.createdAt, JSON.stringify({ ...counts, files: filesRemoved }), actor?.id ?? null, actor?.email ?? null],
    );
    await c.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    // people who were in no other company: their sign-in, Google link and mail links go with them. The platform administrator is never one
    // of them (a company they are in cannot be deleted at all; this is a second lock). A failure here keeps the people (harmless) and
    // never undoes the deletion of the company.
    await c.query("SAVEPOINT people");
    try {
      const gone = await c.query(
        "DELETE FROM users u WHERE u.id = ANY($1::int[]) AND NOT u.is_superadmin AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=u.id)",
        [members],
      );
      peopleRemoved = gone.rowCount;
    } catch (error) {
      await c.query("ROLLBACK TO SAVEPOINT people");
      console.error("Company deletion: people were kept:", error.message);
    }
    // the platform's own log keeps a line about it
    await c.query(
      "INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) SELECT t.id,$2::int,'company.deleted',$3::jsonb FROM tenants t WHERE t.id=$1",
      [PLATFORM_COMPANY, actor?.id ?? null, JSON.stringify({ companyId: tenantId, name: company.name, plan: company.plan, ...counts, files: filesRemoved })],
    );
  });
  return { deleted: { id: tenantId, name: company.name }, removed: { ...counts, files: filesRemoved }, peopleRemoved, numbersNotUnlinked };
}

// The deletions on record, newest first.
export async function deletedCompanies(limit = 50) {
  const { rows } = await query(
    "SELECT id,tenant_id,name,plan,owner_name,owner_email,company_created_at,counts,deleted_by_email,deleted_at FROM deleted_companies ORDER BY deleted_at DESC,id DESC LIMIT $1",
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    companyId: r.tenant_id,
    name: r.name,
    plan: r.plan,
    owner: r.owner_email ? { name: r.owner_name, email: r.owner_email } : null,
    createdAt: r.company_created_at,
    counts: r.counts,
    deletedBy: r.deleted_by_email,
    deletedAt: r.deleted_at,
  }));
}
