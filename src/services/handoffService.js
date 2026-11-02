import { query } from "../db/index.js";
import { createNotifications } from "./notificationService.js";
import { sendTextMessage } from "./messageService.js";
import { emitForConversation } from "./realtime.js";
import { chatTitle } from "./personName.js";

// Customers must know when a machine is answering, and must be able to get a person.
//
// 1. Everything Riwo sends carries a short line saying so, and how to reach a person.
// 2. When a customer asks for a person, in English, Arabic or Hinglish: the chat is marked, Riwo and Autopilot stop
//    answering it, the team is notified (the owner of the chat, or the managers), the chat goes to the top of their list,
//    and the customer is told someone will reply, if a machine had been talking to them.
// 3. A teammate's reply clears the mark.

export const DISCLOSURE = '🤖 Automated reply from Riwo. Reply "human" to talk to a person.';
export const withDisclosure = (text) => `${String(text ?? "").trim()}\n\n${DISCLOSURE}`;
export const ACK = "Thanks, I've let our team know. A person will reply here as soon as they can.";

// Phrases that clearly ask for a person. A lone "human" or "agent" counts only when a machine has been answering,
// because on its own it could be about anything.
const WHO = "(?:human|person|agent|representative|rep|someone|somebody|manager|operator|staff|team member|customer (?:service|care|support))";
const REACH = new RegExp(`\\b(?:talk|speak|chat|connect|transfer|put|get|call|escalat\\w*|contact|reach)\\b[^.?!\\n]{0,30}\\b(?:to|with|through)\\s+(?:a |an |the |some |your |real |live |actual )?${WHO}\\b`, "i");
const REAL = /\b(?:real|live|actual) (?:human|person|agent)\b/i;
const WANT = new RegExp(`\\b(?:want|need|would like|wanna|prefer)\\b[^.?!\\n]{0,20}\\b(?:a human|an agent|a representative|someone real|a real)\\b`, "i");
const ALONE = /^\s*(?:human|agent|a human|a person|person|representative|operator|real person|human please|agent please|live agent)\s*[.!?]*\s*$/i;
const OTHER_LANGUAGES = [
  /(?:موظف|شخص حقيقي|إنسان|بشري|خدمة العملاء|ممثل خدمة|أريد التحدث|اريد التحدث|كلم(?:ني)? مع)/u,
  /(?:इंसान|आदमी से|किसी व्यक्ति|असली व्यक्ति|मानव से|ग्राहक सेवा)/u,
  /\b(?:insaan|insan|aadmi se|asli (?:insaan|person)|real insaan|human se baat|agent se baat|kisi se baat|customer care se baat)\b/i,
];

export function asksForPerson(text, { machineAnswering = false } = {}) {
  const t = String(text ?? "").trim();
  if (!t || t.length > 300) return false;
  if (OTHER_LANGUAGES.some((re) => re.test(t))) return true;
  if (REACH.test(t) || REAL.test(t) || WANT.test(t)) return true;
  return machineAnswering && ALONE.test(t);
}

const MACHINES = ["Riwo", "Automation"];
async function machineAnswered(tenantId, conversationId) {
  return (
    await query(
      `SELECT 1 FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND sender='agent' AND agent_name = ANY($3::text[]) AND created_at > now() - interval '24 hours' LIMIT 1`,
      [tenantId, conversationId, MACHINES],
    )
  ).rowCount > 0;
}

// Called for every new customer message. Does nothing unless the customer asked for a person.
export async function noteHumanRequest({ tenantId, conversationId, messageId, text, io = null }) {
  if (!text || String(text).length > 300) return null;
  const spoken = await machineAnswered(tenantId, conversationId);
  if (!asksForPerson(text, { machineAnswering: spoken })) return null;
  const marked = (
    await query(
      `UPDATE conversations SET needs_human_since=COALESCE(needs_human_since, extract(epoch FROM now())::bigint), updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND NOT is_group AND needs_human_since IS NULL RETURNING id,contact_name,phone,assigned_user_id,session_name`,
      [conversationId, tenantId],
    )
  ).rows[0];
  if (!marked) return null; // already asked: the team has been told once
  // Riwo stops talking to this customer
  await query(
    "UPDATE automation_chats SET status='handed_off',handed_off_reason=COALESCE(handed_off_reason,'The customer asked for a person'),updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND status='active'",
    [tenantId, conversationId],
  );
  const owner = (await query("SELECT owner_user_id FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, marked.session_name])).rows[0]?.owner_user_id;
  const managers = (await query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND status='active' AND role IN ('owner','admin')", [tenantId])).rows.map((r) => r.user_id);
  const people = [...new Set([marked.assigned_user_id || owner, ...managers].filter(Boolean))];
  const who = chatTitle(marked.contact_name, marked.phone);
  await createNotifications({
    io,
    tenantId,
    conversationId,
    dedupeKey: `asked-for-person:${messageId}`,
    recipients: people.map((userId) => ({ userId, type: "handoff" })),
    title: `${who} asked for a person`,
    body: String(text).replace(/\s+/g, " ").slice(0, 140),
  }).catch((e) => console.error("Hand-off notice failed:", e.message));
  if (spoken) {
    // the customer has been talking to a machine: say that a person will follow
    await sendTextMessage({ tenantId, conversationId, text: ACK, idempotencyKey: `asked-for-person-ack:${messageId}`, agentName: "Automation", io }).catch((e) => console.error("Hand-off reply failed:", e.message));
  }
  emitForConversation(io, tenantId, conversationId, "home:changed", { conversationId });
  emitForConversation(io, tenantId, conversationId, "conversation:updated", { conversationId }, { snapshot: true });
  return { conversationId };
}
