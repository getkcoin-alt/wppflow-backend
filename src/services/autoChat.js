import { query, withTransaction } from "../db/index.js";
import { chatForBusiness, unavailableReason, usageOf } from "./aiService.js";
import { sendTextMessage } from "./messageService.js";
import { addContactTag } from "./labelService.js";
import { createNotifications } from "./notificationService.js";
import { isForeignNumber } from "./countries.js";

// "Let Riwo chat": an automation rule that starts a short conversation with a customer and keeps it going until a person
// takes over. The rule sends a fixed welcome first (so the first thing a stranger reads was written by the company). After
// that Riwo may answer, in a sentence or two, only from text the company wrote about itself, and only until:
//   - a teammate (or the phone's owner) writes in the chat, or the chat is closed,
//   - it has answered as many times as the rule allows, or a day has passed,
//   - it cannot help, in which case it says so once, in the company's own words, and tells the team.
// Everything it says is checked before it is sent; nothing the model writes reaches a customer unchecked.

export const AUTO_SENDERS = ["Automation", "Riwo"];
export const RIWO = "Riwo";
const ALIVE_HOURS = 24;
const RESTART_AFTER_DAYS = 7;

// A rule that should not run again, and says why. The engine records it as "skipped", not as a failure to retry.
export class Skipped extends Error {}

// ── The answer, checked ──────────────────────────────────────────────────────────────────────────
const DIGIT_BASES = [0x0660, 0x06f0, 0x0966]; // Arabic-Indic, Persian, Devanagari
const asciiDigits = (text) =>
  String(text).replace(/\p{Nd}/gu, (d) => {
    const code = d.codePointAt(0);
    const base = DIGIT_BASES.find((b) => code >= b && code <= b + 9);
    return base ? String(code - base) : d;
  });
// every run of two or more digits, thousands separators and decimals removed: "1,400,000" and "1.400.000" are 1400000
const figuresOf = (text) =>
  new Set(
    (asciiDigits(text).match(/\d+(?:[.,\s]\d{3})*(?:[.,]\d+)?/g) || [])
      .map((n) => n.replace(/\D/g, ""))
      .filter((n) => n.length >= 2),
  );
const LINKS = /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|ae|in|io|co|app|me|ly|info|sa|uk)\b\S*/gi;

function parseObject(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// What the model said, or why it cannot be used. A reply is refused if it is empty or long, if it carries a figure (a
// price, a date, a phone number) that the company's own text does not contain, or if it carries a link or an address that
// the company's text does not contain. The caller then sends the company's hand-over words instead of the model's.
export function checkAnswer(raw, { knowledge = "", options = [] } = {}) {
  const obj = parseObject(raw);
  if (!obj) return { invalid: "The answer was not in the expected form" };
  const needsPerson = obj.needs_person === true;
  const reply = typeof obj.reply === "string" ? obj.reply.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
  const option = typeof obj.heard_from === "string" ? options.find((o) => o.toLowerCase() === obj.heard_from.trim().toLowerCase()) : undefined;
  const heardFrom = option || null;
  if (needsPerson) return { needsPerson: true, reply: "", heardFrom };
  if (!reply) return { invalid: "The answer was empty" };
  if (reply.length > 320) return { invalid: "The answer was too long" };
  const known = figuresOf(knowledge);
  for (const figure of figuresOf(reply)) if (!known.has(figure)) return { invalid: `The answer contained a figure (${figure}) that is not in the company's text` };
  const haystack = knowledge.toLowerCase();
  for (const link of reply.match(LINKS) || [])
    if (!haystack.includes(link.toLowerCase().replace(/[.,!?)]+$/, ""))) return { invalid: "The answer contained a link or address that is not in the company's text" };
  return { reply, needsPerson: false, heardFrom };
}

// ── Where a chat stands ──────────────────────────────────────────────────────────────────────────
export const chatState = async (tenantId, conversationId, automationId) =>
  (await query("SELECT * FROM automation_chats WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conversationId, automationId])).rows[0] || null;

const handOff = (state, reason) =>
  query(
    "UPDATE automation_chats SET status='handed_off',handed_off_reason=COALESCE(handed_off_reason,$4),updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3 AND status='active'",
    [state.tenant_id, state.conversation_id, state.automation_id, reason],
  );

// Has someone other than the automation spoken to this customer since the chat began? A private note is not speaking to them.
const personSpoke = async (state) =>
  (
    await query(
      `SELECT 1 FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND sender='agent' AND type<>'internal_note'
       AND (agent_name IS NULL OR agent_name<>ALL($4::text[])) AND created_at>$3 LIMIT 1`,
      [state.tenant_id, state.conversation_id, state.created_at, AUTO_SENDERS],
    )
  ).rowCount > 0;

// Is this still a conversation the automation is holding? If a person has taken over, it hands the chat back for good.
async function stillHolding(state, conv) {
  let reason = "";
  if (conv.is_closed) reason = "The chat was closed";
  else if (await personSpoke(state)) reason = "A teammate replied";
  else if (Date.now() - new Date(state.updated_at).getTime() > ALIVE_HOURS * 3600000) reason = "The conversation went quiet for a day";
  if (!reason) return true;
  await handOff(state, reason);
  return false;
}

// "start", "continue", or null: what a rule of this kind does with this message.
export async function autoChatMode(rule, message, conv, isFirst) {
  const state = await chatState(message.tenant_id, conv.id, rule.id);
  if (state?.started_by_message_id === message.id) return "start"; // the first message again, after a failure
  if (state?.status === "active") return (await stillHolding(state, conv)) ? "continue" : null;
  if (state && Date.now() - new Date(state.updated_at).getTime() < RESTART_AFTER_DAYS * 86400000) return null;
  const c = rule.config || {};
  const begins =
    rule.trigger_type === "foreign_number"
      ? isForeignNumber(conv.phone, c.homeCodes || []) && (c.onlyNew === false || isFirst)
      : rule.trigger_type === "first_message"
        ? isFirst
        : false;
  return begins ? "start" : null;
}

export async function startAutoChat({ tenantId, conversationId, automationId, messageId }) {
  await query(
    `INSERT INTO automation_chats(tenant_id,conversation_id,automation_id,status,started_by_message_id)
     VALUES($1,$2,$3,'active',$4)
     ON CONFLICT (tenant_id,conversation_id,automation_id) DO UPDATE SET status='active',started_by_message_id=EXCLUDED.started_by_message_id,
       handed_off_reason=NULL,heard_from=NULL,needs_person=false,created_at=now(),updated_at=now()
     WHERE automation_chats.status<>'active' AND automation_chats.started_by_message_id IS DISTINCT FROM EXCLUDED.started_by_message_id`,
    [tenantId, conversationId, automationId, messageId],
  );
}

// ── Telling the team ─────────────────────────────────────────────────────────────────────────────
async function tellTeam({ io, tenantId, conv, state, title, body }) {
  const managers = (
    await query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND status='active' AND role IN ('owner','admin')", [tenantId])
  ).rows.map((r) => r.user_id);
  const people = conv.assigned_user_id ? [conv.assigned_user_id] : managers;
  await createNotifications({
    io,
    tenantId,
    conversationId: conv.id,
    dedupeKey: `autochat:${conv.id}:${Math.floor(new Date(state.created_at).getTime() / 1000)}:${title}`,
    recipients: people.map((userId) => ({ userId, type: "lead" })),
    title,
    body,
  }).catch((e) => console.error("Automation chat notice failed:", e.message));
}

const NOT_AVAILABLE = {
  not_configured: "Riwo isn't switched on for this server.",
  plan: "Riwo isn't part of this company's plan.",
  disabled: "Riwo has been turned off by an administrator.",
};

const riwoReplies = async (state) =>
  (
    await query("SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND sender='agent' AND agent_name=$4 AND created_at>=$3", [
      state.tenant_id,
      state.conversation_id,
      state.created_at,
      RIWO,
    ])
  ).rows[0].n;

// ── One turn ─────────────────────────────────────────────────────────────────────────────────────
// Runs when a customer writes in a chat that is being held. Safe to run twice for the same message: the reply is sent under
// the execution's own key, and a second run that finds it already there does nothing.
export async function runAutoChatTurn({ rule, message, conv, contact, tenant, execution, io }) {
  const tenantId = message.tenant_id;
  const state = await chatState(tenantId, conv.id, rule.id);
  if (!state || state.status !== "active") throw new Skipped("The conversation had already been handed to a person");
  const key = `automation:${execution.id}:ai`;
  if ((await query("SELECT 1 FROM messages WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, key])).rowCount) return;
  const config = rule.config || {};
  const send = (text) => sendTextMessage({ tenantId, conversationId: conv.id, text, idempotencyKey: key, agentName: RIWO, io });
  const handoffText = config.handoff;
  const bump = () => query("UPDATE automation_chats SET updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id]);

  if ((await riwoReplies(state)) >= (config.maxReplies || 5)) {
    await send(handoffText);
    await handOff(state, `Riwo reached its limit of ${config.maxReplies || 5} replies`);
    await tellTeam({ io, tenantId, conv, state, title: `${contact?.name || conv.contact_name} is waiting for a person`, body: "Riwo has answered as many times as the rule allows. Please take over this chat." });
    return;
  }

  // Not switched on, not in the plan, or today's allowance used: trying again will not help, and a person has to know.
  const giveUp = async (reason) => {
    await handOff(state, reason);
    await tellTeam({ io, tenantId, conv, state, title: `Riwo could not answer ${contact?.name || conv.contact_name}`, body: `${reason} Please take over this chat.` });
    throw new Skipped(reason);
  };
  const unavailable = unavailableReason(tenant);
  if (unavailable) await giveUp(NOT_AVAILABLE[unavailable]);
  if ((await usageOf(tenant)).remaining <= 0) await giveUp("Today's Riwo allowance has been used.");

  let result;
  try {
    result = await chatForBusiness({ tenant, conversationId: conv.id, knowledge: config.knowledge, sourceOptions: config.sourceOptions || [] });
  } catch (error) {
    // the allowance can run out between the check above and the request; anything else (the provider is busy) is tried again
    if (error.status === 429 && /used today's/.test(error.message)) await giveUp("Today's Riwo allowance has been used.");
    throw error;
  }

  const answer = checkAnswer(result.text, { knowledge: config.knowledge || "", options: config.sourceOptions || [] });
  if (answer.invalid) console.warn(`Riwo's answer for chat ${conv.id} was not used: ${answer.invalid}`);

  if (answer.heardFrom && !state.heard_from && contact) {
    await withTransaction((c) => addContactTag(c, tenantId, contact.id, `Found us: ${answer.heardFrom}`));
    await query("UPDATE automation_chats SET heard_from=$4 WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id, answer.heardFrom]);
  }

  if (answer.invalid || answer.needsPerson) {
    // said once; after that the customer already knows a person will follow up
    if (state.needs_person) {
      await bump();
      throw new Skipped("The customer has already been told a person will follow up");
    }
    await send(handoffText);
    await query("UPDATE automation_chats SET needs_person=true,updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id]);
    await tellTeam({ io, tenantId, conv, state, title: `${contact?.name || conv.contact_name} needs a person`, body: "Riwo could not answer this from what your company wrote. Please reply when you can." });
    return;
  }
  await send(answer.reply);
  await bump();
}
