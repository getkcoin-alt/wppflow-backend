import { query } from "../db/index.js";

// Two rules every automatic reply obeys, whatever rule or agent wrote it:
//  1. A person got there first. If a teammate (or the phone's owner, typing on the phone) has written in the chat since the
//     customer's message, nothing automatic is sent, however long the model took to think or the job waited in the queue.
//  2. Your own numbers are not customers. A chat with the number this inbox is connected to (a note to yourself), or with
//     another number the company has connected, is never answered automatically, so two of your own numbers cannot start talking
//     to each other and a message you send to yourself is never "answered".

// A rule that should not run (again), and says why. The engine records it as "skipped", not as a failure to retry.
export class Skipped extends Error {}

// More than this many automatic replies to one chat in an hour means two bots are talking to each other.
export const REPLIES_PER_HOUR = 6;
// A workflow talks more than a one-line rule: its own ceiling, which only a loop with another machine could reach.
export const WORKFLOW_MESSAGES_PER_HOUR = 20;

// Everything the system itself says in a chat. Anything else written by an "agent" is a person.
export const AUTOMATIC_SENDERS = ["Riwo", "Automation", "Campaign"];

export async function personAnswered(message) {
  if (!message?.conversation_id) return false;
  const { rows } = await query(
    `SELECT 1 FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND sender='agent' AND type<>'internal_note'
       AND (agent_name IS NULL OR agent_name<>ALL($3::text[]))
       AND created_at>=$4 AND timestamp_epoch>=$5 LIMIT 1`,
    [message.tenant_id, message.conversation_id, AUTOMATIC_SENDERS, message.created_at, Number(message.timestamp_epoch || 0) - 5],
  );
  return rows.length > 0;
}

export async function assertUnanswered(message) {
  if (await personAnswered(message)) throw new Skipped("A person had already answered this message");
}

export async function assertUnansweredById(tenantId, messageId) {
  if (!messageId) return;
  const message = (await query("SELECT * FROM messages WHERE id=$1 AND tenant_id=$2", [messageId, tenantId])).rows[0];
  if (message) await assertUnanswered(message);
}

// "919971694047@c.us", "+91 99716 94047", "919971694047:12@c.us" -> "919971694047"
export const digitsOf = (value) => String(value ?? "").replace(/[:@].*$/, "").replace(/\D/g, "");
// the same number, with or without its country code (a local number is at least 9 digits and ends the full one)
export function sameNumber(a, b) {
  const x = digitsOf(a);
  const y = digitsOf(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 9 && long.endsWith(short);
}

export async function isOwnNumber(tenantId, phone) {
  if (!digitsOf(phone)) return false;
  const { rows } = await query("SELECT phone FROM whatsapp_sessions WHERE tenant_id=$1 AND phone IS NOT NULL AND phone<>''", [tenantId]);
  return rows.some((r) => sameNumber(r.phone, phone));
}
