import { query } from "../db/index.js";
import { verifyChain } from "./auditTrail.js";

// A company's data, in a form it can take elsewhere: contacts, conversations and who they are assigned to, the team, the sales
// pipeline with its history, saved replies, labels, broadcast permission, and the record of what the machine said. Messages
// are exported separately as a CSV, in pages, so a large company does not have to fit in memory. Files and pictures are not
// included: the export lists them by name and message so they can be fetched. Only the company asking is ever read.

const all = async (sql, params) => (await query(sql, params)).rows;

export async function buildExport(tenantId) {
  const [company] = await all("SELECT id,name,plan,status,created_at FROM tenants WHERE id=$1", [tenantId]);
  const team = await all(
    `SELECT u.id,u.name,u.email,m.role,m.status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.id`,
    [tenantId],
  );
  const contacts = await all("SELECT * FROM contacts WHERE tenant_id=$1 ORDER BY id", [tenantId]);
  const conversations = await all(
    `SELECT id,session_name,contact_id,phone,contact_name,is_group,assigned_to,assigned_user_id,is_closed,is_archived,tags,
            last_active_epoch,awaiting_since,needs_human_since,needs_human_reason,created_at
       FROM conversations WHERE tenant_id=$1 AND provider_chat_id !~ '@(broadcast|newsletter)$' ORDER BY created_at,id`,
    [tenantId],
  );
  const pipelines = await all("SELECT id,name,preset,created_at FROM pipelines WHERE tenant_id=$1", [tenantId]);
  const stages = await all("SELECT id,pipeline_id,name,kind,position FROM pipeline_stages WHERE tenant_id=$1 ORDER BY pipeline_id,position", [tenantId]);
  const leads = await all(
    `SELECT l.id,l.contact_id,l.contact_name,l.phone,l.title,l.value,l.status,s.name AS stage,l.owner_user_id,l.source,l.expected_close,l.lost_reason,l.created_at,l.updated_at,l.closed_at
       FROM leads l JOIN pipeline_stages s ON s.id=l.stage_id WHERE l.tenant_id=$1 ORDER BY l.created_at,l.id`,
    [tenantId],
  );
  const leadHistory = await all("SELECT id,lead_id,actor_name,type,detail,created_at FROM lead_activities WHERE tenant_id=$1 ORDER BY id", [tenantId]);
  const followUps = await all("SELECT id,lead_id,conversation_id,title,due_at,assigned_user_id,done_at,created_at FROM lead_tasks WHERE tenant_id=$1 ORDER BY created_at,id", [tenantId]);
  const labels = await all("SELECT * FROM labels WHERE tenant_id=$1", [tenantId]);
  const contactLabels = await all("SELECT * FROM contact_labels WHERE tenant_id=$1", [tenantId]);
  const savedReplies = await all("SELECT id,shortcut,title,text FROM canned_replies WHERE tenant_id=$1 ORDER BY shortcut", [tenantId]);
  const consents = await all("SELECT phone,opt_in_status,source,consented_at FROM consents WHERE tenant_id=$1 ORDER BY phone", [tenantId]);
  const automated = await all("SELECT id,created_at,conversation_id,event,source,rule_ref,trigger_message_id,message_id,provider,model,text,reversible,undoes,prev_hash,hash FROM automation_audit WHERE tenant_id=$1 ORDER BY id", [tenantId]);
  return {
    format: "scriwo-export/1",
    exportedAt: new Date().toISOString(),
    company,
    team,
    contacts,
    contactLabels,
    labels,
    consents,
    conversations,
    pipeline: { pipelines, stages, leads, history: leadHistory, followUps },
    savedReplies,
    automatedMessages: { chain: await verifyChain(tenantId), rows: automated },
    notes: [
      "Messages are in the separate messages file (CSV), one row per message.",
      "Pictures, voice notes and documents are not inside this file; the messages file names them and the message they belong to.",
    ],
  };
}

// CSV, with cells that a spreadsheet would run as a formula made harmless
const cell = (v) => {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvLine = (values) => values.map(cell).join(",") + "\r\n";

export const MESSAGE_COLUMNS = ["id", "conversation_id", "sender", "agent_name", "type", "text", "file_name", "timestamp_epoch", "status", "created_at"];

// Messages in pages of 1000 by id, oldest first, so the whole history is written without being held in memory.
export async function* messageCsv(tenantId) {
  yield "﻿" + csvLine(MESSAGE_COLUMNS);
  let after = "";
  for (;;) {
    const rows = await all(
      `SELECT ${MESSAGE_COLUMNS.join(",")} FROM messages WHERE tenant_id=$1 AND id>$2 ORDER BY id LIMIT 1000`,
      [tenantId, after],
    );
    if (!rows.length) return;
    yield rows.map((r) => csvLine(MESSAGE_COLUMNS.map((c) => r[c]))).join("");
    after = rows[rows.length - 1].id;
  }
}
