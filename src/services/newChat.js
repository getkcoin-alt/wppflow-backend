import crypto from "node:crypto";
import { query } from "../db/index.js";
import { fail } from "../middleware/http.js";
import { defaultWhatsAppProvider as provider } from "./whatsapp/WhatsAppProvider.js";
import { assertRoomForContacts } from "./limitsService.js";
import { normalizePhone, displayPhone, PHONE_HELP } from "./phone.js";

// Starting a chat with a number the company has not spoken to yet: shared by the "new chat" button in the inbox and by an AI agent allowed to
// start chats (services/agents/tools.js, message_new_number), so both make the same checks.

// The contact for a number typed in, made if it is new. The number must be on WhatsApp, and the WhatsApp number it goes out from must be connected.
// WhatsApp knows the number's real address (some countries differ from how people write it), which is what is saved.
export async function contactForNumber({ tenantId, sessionName, phone, name = "", io = null }) {
  const typed = normalizePhone(phone);
  if (!typed) throw fail(400, PHONE_HELP);
  const line = await query("SELECT status FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, sessionName]);
  if (line.rows[0]?.status !== "CONNECTED") throw fail(409, "That WhatsApp number is not connected right now. Reconnect it under Numbers, or choose another number.");
  const found = await provider.checkNumber(tenantId, sessionName, typed);
  if (found.checked && !found.exists) throw fail(422, `${displayPhone(typed)} is not on WhatsApp. Check the number and the country code.`);
  const real = found.jid && /^\d{8,15}@c\.us$/.test(found.jid) ? found.jid.replace(/@c\.us$/, "") : typed;
  const known = await query("SELECT * FROM contacts WHERE tenant_id=$1 AND phone = ANY($2::text[]) ORDER BY (phone=$3) DESC LIMIT 1", [tenantId, [real, `+${real}`], real]);
  if (known.rows[0]) return { contact: known.rows[0], created: false, real };
  const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 255) : "";
  await assertRoomForContacts(tenantId, 1);
  const inserted = await query(
    "INSERT INTO contacts(id,tenant_id,name,phone,name_edited) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,phone) DO UPDATE SET updated_at=contacts.updated_at RETURNING *",
    [crypto.randomUUID(), tenantId, label || displayPhone(real), real, Boolean(label)],
  );
  io?.to(`tenant:${tenantId}`).emit("contact:changed", { contactId: inserted.rows[0].id });
  return { contact: inserted.rows[0], created: true, real };
}

// The chat with this contact on this number, made if there is none yet
export async function chatWithContact({ tenantId, sessionName, contact }) {
  const jid = contact.phone.includes("@") ? contact.phone : `${contact.phone.replace(/\D/g, "")}@c.us`;
  const { rows } = await query(
    `INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,contact_id,phone,contact_name,avatar) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(tenant_id,session_name,provider_chat_id) DO UPDATE SET contact_id=EXCLUDED.contact_id RETURNING *`,
    [crypto.randomUUID(), tenantId, sessionName, jid, contact.id, contact.phone, contact.name, contact.avatar],
  );
  return rows[0];
}
