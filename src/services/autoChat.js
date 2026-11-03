import { query, withTransaction } from "../db/index.js";
import { chatAsAgent, chatForBusiness, unavailableReason, usageOf } from "./aiService.js";
import { sendTextMessage } from "./messageService.js";
import { addContactTag } from "./labelService.js";
import { createNotifications } from "./notificationService.js";
import { withDisclosure } from "./handoffService.js";
import { isForeignNumber } from "./countries.js";
import { knowledgeFor } from "./knowledgeService.js";
import { Skipped, assertUnanswered, personAnswered } from "./personGuard.js";
import { asksForCommercial, questionsOf, answeredNumbers, nextQuestion, withAnswer, withFacts, handOffToExecutive, ensureLead } from "./salesAssistant.js";

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
export { Skipped };

// What Riwo may talk about for this message: the company's knowledge base (its profile, notes and the pages that match what
// the customer wrote), and the text written in the rule. The answer is checked against exactly this.
export async function knowledgeOf(config, tenantId, customerText) {
  const fromBase = config.useKnowledge ? await knowledgeFor(tenantId, customerText).catch(() => "") : "";
  return [fromBase, config.knowledge].filter(Boolean).join("\n\n");
}

// ── The answer, checked ──────────────────────────────────────────────────────────────────────────
const DIGIT_BASES = [0x0660, 0x06f0, 0x0966]; // Arabic-Indic, Persian, Devanagari
const asciiDigits = (text) =>
  String(text).replace(/\p{Nd}/gu, (d) => {
    const code = d.codePointAt(0);
    const base = DIGIT_BASES.find((b) => code >= b && code <= b + 9);
    return base ? String(code - base) : d;
  });
// every run of two or more digits, thousands separators and decimals removed: "1,400,000" and "1.400.000" are 1400000
// a single digit counts only when it is a percentage or an amount of money: "5%", "AED 5", "$5"
const SMALL_FIGURES = /(?<![\d.,])(\d)\s*%|(?:[$€£₹]|\b(?:aed|inr|usd|sar|eur|gbp|rs)\b\.?)\s*(\d)(?![\d]|[.,]\d)/gi;
const figuresOf = (text) => {
  const ascii = asciiDigits(text);
  const found = new Set(
    (ascii.match(/\d+(?:[.,\s]\d{3})*(?:[.,]\d+)?/g) || [])
      .map((n) => n.replace(/\D/g, ""))
      .filter((n) => n.length >= 2),
  );
  for (const m of ascii.matchAll(SMALL_FIGURES)) found.add(m[1] || m[2]);
  return found;
};
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
export function checkAnswer(raw, { knowledge = "", options = [], allowEmpty = false, maxLength = 320 } = {}) {
  const obj = parseObject(raw);
  if (!obj) return { invalid: "The answer was not in the expected form" };
  const needsPerson = obj.needs_person === true;
  const reply = typeof obj.reply === "string" ? obj.reply.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
  const option = typeof obj.heard_from === "string" ? options.find((o) => o.toLowerCase() === obj.heard_from.trim().toLowerCase()) : undefined;
  const heardFrom = option || null;
  // what the customer said in answer to the company's questions: short plain text, keyed by the question's number
  const answers = {};
  if (obj.answers && typeof obj.answers === "object" && !Array.isArray(obj.answers))
    for (const [n, v] of Object.entries(obj.answers)) {
      const text = typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, 300) : "";
      if (/^\d{1,2}$/.test(n) && text) answers[Number(n)] = text;
    }
  const ready = obj.ready_to_hand_off === true;
  const collected = obj.collected && typeof obj.collected === "object" && !Array.isArray(obj.collected) ? obj.collected : {};
  if (needsPerson) return { needsPerson: true, reply: "", heardFrom, answers, collected, ready };
  if (!reply && allowEmpty) return { reply: "", needsPerson: false, heardFrom, answers, collected, ready };
  if (!reply) return { invalid: "The answer was empty" };
  if (reply.length > maxLength) return { invalid: "The answer was too long" };
  const known = figuresOf(knowledge);
  for (const figure of figuresOf(reply)) if (!known.has(figure)) return { invalid: `The answer contained a figure (${figure}) that is not in the company's text` };
  const haystack = knowledge.toLowerCase();
  for (const link of reply.match(LINKS) || [])
    if (!haystack.includes(link.toLowerCase().replace(/[.,!?)]+$/, ""))) return { invalid: "The answer contained a link or address that is not in the company's text" };
  return { reply, needsPerson: false, heardFrom, answers, collected, ready };
}

// ── Where a chat stands ──────────────────────────────────────────────────────────────────────────
export const chatState = async (tenantId, conversationId, automationId) =>
  (await query("SELECT * FROM automation_chats WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conversationId, automationId])).rows[0] || null;

const handOff = (state, reason) =>
  query(
    "UPDATE automation_chats SET status='handed_off',handed_off_reason=COALESCE(handed_off_reason,$4),updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3 AND status='active'",
    [state.tenant_id, state.conversation_id, state.automation_id, reason],
  );

// Has someone other than the automation spoken to this customer since the message that started the chat? A private note is not
// speaking to them. The count starts at that message, not at the moment the rule got to it: a person who answered in between
// has already taken the chat.
const personSpoke = async (state) =>
  (
    await query(
      `SELECT 1 FROM messages m WHERE m.tenant_id=$1 AND m.conversation_id=$2 AND m.sender='agent' AND m.type<>'internal_note'
       AND (m.agent_name IS NULL OR m.agent_name<>ALL($4::text[]))
       AND m.created_at>LEAST($3::timestamptz,COALESCE((SELECT s.created_at FROM messages s WHERE s.id=$5 AND s.tenant_id=$1),$3::timestamptz)) LIMIT 1`,
      [state.tenant_id, state.conversation_id, state.created_at, AUTO_SENDERS, state.started_by_message_id],
    )
  ).rowCount > 0;

// Is this still a conversation the automation is holding? If a person has taken over, it hands the chat back for good.
async function stillHolding(state, conv) {
  let reason = "";
  if (conv.is_closed) reason = "The chat was closed";
  else if (conv.needs_human_since) reason = "The customer asked for a person";
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
       handed_off_reason=NULL,heard_from=NULL,needs_person=false,step=0,requirements='[]'::jsonb,outcome=NULL,created_at=now(),updated_at=now()
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
  // a teammate (or the phone's owner) got there first: nothing is asked of the model, and the chat is handed back for good
  if (await personAnswered(message)) {
    await handOff(state, "A teammate replied");
    throw new Skipped("A person had already answered this message");
  }
  const config = rule.config || {};
  const ruleRef = `${config.sales?.enabled ? "sales assistant" : "Riwo chat"}: rule ${rule.id}`;
  const modelInfo = { provider: "", model: "" }; // filled in when the model has been asked, so the record says which one wrote what
  // a person may have answered while the model was thinking: that is checked again at the moment of sending
  const send = async (text) => {
    await assertUnanswered(message);
    return sendTextMessage({ tenantId, conversationId: conv.id, text: withDisclosure(text), idempotencyKey: key, agentName: RIWO, io, audit: { source: config.sales?.enabled ? "sales_assistant" : "riwo_chat", ruleRef, triggerMessageId: message.id, provider: modelInfo.provider, model: modelInfo.model } });
  };
  const handoffText = config.handoff;
  const bump = () => query("UPDATE automation_chats SET updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id]);

  const knowledge = await knowledgeOf(config, tenantId, message.text);
  if (config.agent?.enabled) return runAgentTurn({ rule, message, conv, contact, tenant, execution, io, state, config, send, bump, modelInfo, knowledge });
  if (config.sales?.enabled) return runSalesTurn({ rule, message, conv, contact, tenant, execution, io, state, config, send, bump, modelInfo, knowledge });

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
    result = await chatForBusiness({ tenant, conversationId: conv.id, knowledge, sourceOptions: config.sourceOptions || [] });
    modelInfo.provider = result.provider || "";
    modelInfo.model = result.model || "";
  } catch (error) {
    // the allowance can run out between the check above and the request; anything else (the provider is busy) is tried again
    if (error.status === 429 && /used today's/.test(error.message)) await giveUp("Today's Riwo allowance has been used.");
    throw error;
  }

  const answer = checkAnswer(result.text, { knowledge, options: config.sourceOptions || [] });
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

// ── The sales assistant ──────────────────────────────────────────────────────────────────────────
// First message of a chat: if it already asks for pricing, the formal hand-off is the answer; otherwise the company's welcome
// goes out together with the first question.
export async function startSales({ rule, message, conv, contact, tenant, execution, io, say }) {
  const tenantId = message.tenant_id;
  const state = await chatState(tenantId, conv.id, rule.id);
  const questions = questionsOf(rule);
  if (asksForCommercial(message.text)) {
    await handOffToExecutive({ rule, state, conv, contact, execution, io, reason: "pricing", requirements: [], company: tenant.name, lastText: message.text, since: message.timestamp_epoch });
    return;
  }
  await say([rule.config.reply, questions[0]].filter(Boolean).join("\n\n"), ":reply");
  await query("UPDATE automation_chats SET step=GREATEST(step,1),updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id]);
}

// A later message in a chat the sales assistant is holding. In order: a request for pricing or a proposal is handed to an
// executive without asking the model; then what the customer said is kept as answers (read by the model when one is available,
// otherwise taken as the answer to the question just asked); then the next question, or the hand-off when none are left.
async function runSalesTurn({ rule, message, conv, contact, tenant, execution, io, state, config, send, bump, modelInfo, knowledge }) {
  const tenantId = message.tenant_id;
  const questions = questionsOf(rule);
  let requirements = Array.isArray(state.requirements) ? state.requirements : [];
  const hand = (reason) => handOffToExecutive({ rule, state, conv, contact, execution, io, reason, requirements, company: tenant.name, lastText: message.text, since: message.timestamp_epoch });

  if (asksForCommercial(message.text, { lastQuestion: questions[state.step - 1] || "" })) return void (await hand("pricing"));

  let reply = "";
  let needsPerson = false;
  let read = false;
  if (!unavailableReason(tenant) && (await usageOf(tenant)).remaining > 0) {
    try {
      const done = answeredNumbers(requirements);
      const result = await chatForBusiness({
        tenant,
        conversationId: conv.id,
        knowledge,
        sourceOptions: config.sourceOptions || [],
        questions: questions.map((text, i) => ({ n: i + 1, text, answered: done.has(i + 1) })),
      });
      modelInfo.provider = result.provider || "";
      modelInfo.model = result.model || "";
      const opts = { knowledge, options: config.sourceOptions || [], allowEmpty: true };
      let answer = checkAnswer(result.text, opts);
      if (answer.invalid) {
        // what Riwo wanted to say is not used, but what the customer told us still counts: only the reply is dropped
        console.warn(`Riwo's answer for chat ${conv.id} was not used: ${answer.invalid}`);
        const obj = parseObject(result.text);
        answer = obj ? checkAnswer(JSON.stringify({ ...obj, reply: "" }), opts) : answer;
      }
      if (!answer.invalid) {
        read = true;
        for (const [n, text] of Object.entries(answer.answers || {})) requirements = withAnswer(requirements, questions, Number(n), text);
        reply = answer.reply;
        needsPerson = answer.needsPerson;
        if (answer.heardFrom && !state.heard_from && contact) {
          await withTransaction((c) => addContactTag(c, tenantId, contact.id, `Found us: ${answer.heardFrom}`));
          await query("UPDATE automation_chats SET heard_from=$4 WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id, answer.heardFrom]);
        }
      }
    } catch (error) {
      console.warn(`Riwo could not read chat ${conv.id}: ${error.message}`); // the questions carry on without it
    }
  }
  // no model: the customer's message answers the question that was just asked
  if (!read && state.step > 0) requirements = withAnswer(requirements, questions, state.step, message.text);

  const hadNone = !(state.requirements || []).length;
  await query("UPDATE automation_chats SET requirements=$4 WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id, JSON.stringify(requirements)]);
  // the lead appears as soon as the customer has told us something
  if (hadNone && requirements.length) await ensureLead({ tenantId, conv, name: contact?.name || conv.contact_name, requirements, io }).catch((e) => console.error("Sales assistant could not open a lead:", e.message));

  if (needsPerson) {
    // something Riwo cannot answer from the company's text: said once, and the team is told (as for any chat Riwo holds)
    if (state.needs_person) {
      await bump();
      throw new Skipped("The customer has already been told a person will follow up");
    }
    await send(config.handoff);
    await query("UPDATE automation_chats SET needs_person=true,updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id]);
    await tellTeam({ io, tenantId, conv, state, title: `${contact?.name || conv.contact_name} needs a person`, body: "Riwo could not answer this from what your company wrote. Please reply when you can." });
    return;
  }

  const next = nextQuestion(questions, requirements);
  if (!next) return void (await hand("qualified"));
  if ((await riwoReplies(state)) >= (config.maxReplies || questions.length + 3)) return void (await hand("limit"));
  await send([reply, questions[next - 1]].filter(Boolean).join("\n\n"));
  await query("UPDATE automation_chats SET step=$4,updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id, next]);
}

// ── The sales agent ──────────────────────────────────────────────────────────────────────────────
// A free conversation from the knowledge base, toward the goal the owner described. In order: prices and proposals go to a person
// (unless the company let Riwo repeat the prices on its website); the reply is written from the knowledge base and checked, with one
// second try if it carried a figure or link the company never wrote; what the customer said is kept; and when the customer is
// ready, or Riwo is unsure, a person takes over with a summary.
async function runAgentTurn({ rule, message, conv, contact, tenant, execution, io, state, config, send, bump, modelInfo, knowledge }) {
  const tenantId = message.tenant_id;
  const agent = config.agent;
  let requirements = Array.isArray(state.requirements) ? state.requirements : [];
  const hand = (reason) => handOffToExecutive({ rule, state, conv, contact, execution, io, reason, requirements, company: tenant.name, lastText: message.text, since: message.timestamp_epoch });
  const tellNeedsPerson = async () => {
    if (state.needs_person) {
      await bump();
      throw new Skipped("The customer has already been told a person will follow up");
    }
    await send(config.handoff);
    await query("UPDATE automation_chats SET needs_person=true,requirements=$4,updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id, JSON.stringify(requirements)]);
    await tellTeam({ io, tenantId, conv, state, title: `${contact?.name || conv.contact_name} needs a person`, body: "Riwo could not answer this from what your company wrote. Please reply when you can." });
  };

  if (agent.pricing !== "knowledge" && asksForCommercial(message.text)) return void (await hand("pricing"));
  // a customer who has been told a person will follow up is not answered again by Riwo until that person has
  if (state.needs_person) {
    await bump();
    throw new Skipped("The customer has already been told a person will follow up");
  }
  const max = config.maxReplies || 12;
  if ((await riwoReplies(state)) >= max) return void (await hand("limit"));
  if (unavailableReason(tenant) || (await usageOf(tenant)).remaining <= 0) return void (await tellNeedsPerson());

  const learned = Object.fromEntries(requirements.map((r) => [r.question, r.answer]));
  let answer = null;
  let correction = "";
  for (let attempt = 0; attempt < 2 && !answer; attempt++) {
    const result = await chatAsAgent({ tenant, conversationId: conv.id, knowledge, agent, collected: learned, correction });
    modelInfo.provider = result.provider || "";
    modelInfo.model = result.model || "";
    const checked = checkAnswer(result.text, { knowledge, options: [], maxLength: 500 });
    if (!checked.invalid) answer = checked;
    else {
      console.warn(`Riwo's agent reply for chat ${conv.id} was not used: ${checked.invalid}`);
      correction = checked.invalid.endsWith(".") ? checked.invalid : `${checked.invalid}.`;
      // what the customer said still counts, even when the words could not be used
      const salvage = parseObject(result.text);
      if (salvage?.collected) requirements = withFacts(requirements, salvage.collected);
    }
  }
  if (!answer) return void (await tellNeedsPerson());

  const hadNone = !(state.requirements || []).length;
  requirements = withFacts(requirements, answer.collected);
  await query("UPDATE automation_chats SET requirements=$4 WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3", [tenantId, conv.id, rule.id, JSON.stringify(requirements)]);
  if (hadNone && requirements.length) await ensureLead({ tenantId, conv, name: contact?.name || conv.contact_name, requirements, io }).catch((e) => console.error("Riwo agent could not open a lead:", e.message));

  if (answer.needsPerson) return void (await tellNeedsPerson());
  // the customer is ready: your formal message goes out and a person takes the conversation, with what Riwo learned
  if (answer.ready) return void (await hand("qualified"));
  await send(answer.reply);
  await bump();
}
