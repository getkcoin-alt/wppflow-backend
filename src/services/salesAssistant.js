import { query } from "../db/index.js";
import { sendTextMessage } from "./messageService.js";
import { assertUnansweredById } from "./personGuard.js";
import { createNotifications } from "./notificationService.js";
import { emitForConversation } from "./realtime.js";
import { chatTitle } from "./personName.js";
import { personalise } from "./templating.js";
import { withDisclosure } from "./handoffService.js";
import { createLeadFromChat, ensurePipeline, stagesOf, advanceLeadBySystem, noteOnLead, addSystemTask } from "./leadService.js";

// The sales assistant: Riwo asks the company's own discovery questions one at a time and keeps the answers, and the moment
// a customer asks for pricing, a quote or a proposal it stops, sends one fixed formal message (written by the company, never
// by the model), hands the chat to an executive, opens a lead in the pipeline and tells the team what the customer needs.
// Nothing here needs the AI: the questions, the pricing hand-off and the pipeline all work when no provider is available.

const RIWO = "Riwo";

// ── Does the customer want a price, a quote or a proposal? ───────────────────────────────────────
// Words, in English, Arabic, Hindi and Hinglish. A false alarm only costs a hand-off to a person, so these err on the side of
// handing over. The model is never asked to decide this and never answers it.
const COMMERCIAL = [
  /\b(?:price|prices|pricing|priced|pricelist)\b/i,
  /\bprice ?list\b/i,
  /\b(?:quote|quotes|quoted|quotation|quotations)\b/i,
  /\bproposals?\b/i,
  /\b(?:rate card|rate list|rates|tariffs?)\b/i,
  /\bhow much\b/i,
  /\b(?:cost|costs|charges|fees)\b/i,
  /\b(?:estimate|estimation)\b/i,
  /\bdiscounts?\b/i,
  /(?:سعر|أسعار|اسعار|تسعير|تسعيرة|عرض سعر|عرض أسعار|عرض اسعار|بكم|تكلفة|التكلفة|تكاليف|ثمن|اقتراح|عرض مالي)/u,
  /(?:कीमत|दाम|रेट|भाव|मूल्य|कोटेशन|प्रस्ताव|कितना लगेगा|कितने का|कितने में|खर्च)/u,
  /\b(?:kitna lagega|kitne ka|kitne mein|kitne me|kitna paisa|kitne paise|daam|kimat|keemat|bhav|bhaav|rate kya|price kya|rate batao|rate bhej|quotation)\b/i,
];
const BUDGET_TALK = /(?:budget|ميزانية|बजट)/i;
const A_REQUEST = /(?:\b(?:send|share|give|need|want|can you|could you|please|tell me|show|what(?:'s| is)|how)\b|[?؟]|भेज|बताओ|बताइए|चाहिए|ارسل|أرسل|ابغى|أريد|اريد|ممكن)/iu;

export function asksForCommercial(text, { lastQuestion = "" } = {}) {
  const t = String(text ?? "").trim();
  if (!t || t.length > 600) return false;
  if (!COMMERCIAL.some((re) => re.test(t))) return false;
  // the company just asked about budget or price: "around 5000" answers it. Only a request ("send me the price list") hands over.
  if (COMMERCIAL.some((re) => re.test(lastQuestion)) || BUDGET_TALK.test(lastQuestion)) return A_REQUEST.test(t);
  return true;
}

// ── What has been learnt ─────────────────────────────────────────────────────────────────────────
export const questionsOf = (rule) => (Array.isArray(rule.config?.sales?.questions) ? rule.config.sales.questions : []);
export const answeredNumbers = (requirements) => new Set((requirements || []).map((r) => r.n));
// the first question (counting from 1) that has no answer yet, or 0 when every one has
export function nextQuestion(questions, requirements) {
  const done = answeredNumbers(requirements);
  for (let n = 1; n <= questions.length; n++) if (!done.has(n)) return n;
  return 0;
}
export function withAnswer(requirements, questions, n, answer) {
  const text = String(answer ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text || !questions[n - 1] || answeredNumbers(requirements).has(n)) return requirements || [];
  return [...(requirements || []), { n, question: questions[n - 1], answer: text }].sort((a, b) => a.n - b.n);
}
// Facts Riwo learned in a free conversation (labels and short values), kept beside the answers to fixed questions
export function withFacts(requirements, facts) {
  const list = [...(requirements || [])];
  let n = list.reduce((m, r) => Math.max(m, r.n), 0);
  for (const [rawLabel, rawValue] of Object.entries(facts && typeof facts === "object" ? facts : {}).slice(0, 12)) {
    const label = String(rawLabel).replace(/<\/?[a-z_]+>/gi, "").replace(/\s+/g, " ").trim().slice(0, 40);
    const value = String(rawValue ?? "").replace(/<\/?[a-z_]+>/gi, "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!label || !value || value.toLowerCase() === "unknown") continue;
    const at = list.findIndex((r) => r.question.toLowerCase() === label.toLowerCase());
    if (at >= 0) list[at] = { ...list[at], answer: value };
    else list.push({ n: ++n, question: label, answer: value });
  }
  return list.slice(0, 20);
}
// a fixed question reads "What are you looking for? Buy a flat"; a fact Riwo learned reads "Company size: 40 people"
export const summaryOf = (requirements) => (requirements || []).map((r) => `• ${r.question}${/[?؟]$/.test(r.question) ? " " : ": "}${r.answer}`).join("\n");

// ── Handing the chat to an executive ─────────────────────────────────────────────────────────────
const REASONS = {
  pricing: "asked for pricing or a proposal",
  qualified: "answered all the questions",
  limit: "reached the limit of Riwo's replies",
  unclear: "gave an answer Riwo could not understand",
};

// the step of the pipeline the lead should be in: the company's own choice, or the one that looks like a proposal
function chooseStage(stages, sales, reason) {
  const open = stages.filter((s) => s.kind === "open");
  const named = sales.stageName && open.find((s) => s.name.toLowerCase() === sales.stageName.toLowerCase());
  if (named && reason === "pricing") return named;
  if (reason === "pricing") return open.find((s) => /proposal|quot|offer/i.test(s.name)) || open[1] || open[0];
  return open.find((s) => /qualif/i.test(s.name)) || null; // a finished conversation without a price request: qualified, if the pipeline has such a step
}

async function peopleToTell(tenantId, conv) {
  const owner = (await query("SELECT owner_user_id FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, conv.session_name])).rows[0]?.owner_user_id;
  const managers = (await query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND status='active' AND role IN ('owner','admin')", [tenantId])).rows.map((r) => r.user_id);
  return [...new Set([conv.assigned_user_id, owner, ...managers].filter(Boolean))];
}

// The customer's lead: made the first time they answer a question, and the same one is used from then on. The pipeline itself
// is made for a company that has none yet.
export async function ensureLead({ tenantId, conv, name, requirements, io }) {
  const fresh = (await query("SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2", [conv.id, tenantId])).rows[0];
  const first = requirements[0]?.answer;
  const who = chatTitle(name, conv.phone) || "New enquiry";
  const made = await createLeadFromChat({ tenantId, conversation: fresh, source: "automation", title: first ? `${who}: ${first}`.slice(0, 120) : who, io });
  return made.id;
}

// Marks the chat, tells the customer, opens the lead, notes what was learnt and makes the team's follow-up.
// Safe to run twice for the same message: the message and the note carry the execution's key, and the lead is never doubled.
export async function handOffToExecutive({ rule, state, conv, contact, execution, io, reason, requirements, company = "", lastText = "", since = null }) {
  // "I will take over" is not said when a person already has: they are in the chat
  await assertUnansweredById(conv.tenant_id, execution?.message_id);
  const tenantId = state.tenant_id;
  const sales = rule.config.sales;
  const name = contact?.name || conv.contact_name;
  const executive = conv.assigned_user_id ? (await query("SELECT name FROM users WHERE id=$1", [conv.assigned_user_id])).rows[0]?.name || "" : "";

  // 1. the customer is told, in the company's own formal words. This goes first: if it cannot be sent the whole step is tried
  // again (the chat is still held), and a second try sends nothing twice.
  const formal = personalise(String(sales.formal).replace(/\{\{\s*executive\s*\}\}/gi, executive), { name, company })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
  await sendTextMessage({ tenantId, conversationId: conv.id, text: withDisclosure(formal), idempotencyKey: `automation:${execution.id}:sales`, agentName: RIWO, io, audit: { source: "sales_assistant", ruleRef: `sales assistant hand-off (${reason}): rule ${rule.id}`, triggerMessageId: execution.message_id || null } });

  // 2. the chat is marked (as when a customer asks for a person), so Riwo and Autopilot go quiet and the team's list shows it
  await query(
    `UPDATE conversations SET needs_human_since=COALESCE(needs_human_since, extract(epoch FROM now())::bigint),
       needs_human_reason=CASE WHEN needs_human_since IS NULL THEN $3 ELSE needs_human_reason END, updated_at=now()
     WHERE id=$1 AND tenant_id=$2 AND NOT is_group`,
    [conv.id, tenantId, reason],
  );
  await query(
    "UPDATE automation_chats SET status='handed_off',handed_off_reason=COALESCE(handed_off_reason,$4),outcome=COALESCE(outcome,$5),requirements=$6,updated_at=now() WHERE tenant_id=$1 AND conversation_id=$2 AND automation_id=$3",
    [tenantId, conv.id, rule.id, `The customer ${REASONS[reason]}`, reason, JSON.stringify(requirements)],
  );

  // Riwo's own message does not end the customer's wait: they are still waiting for a person, so the chat stays on the team's list
  if (since) await query("UPDATE conversations SET awaiting_since=COALESCE(awaiting_since,$3) WHERE id=$1 AND tenant_id=$2 AND NOT is_group", [conv.id, tenantId, Number(since)]);

  // 3. the lead, in the right step of the pipeline, with what the customer said they need
  let leadId = null;
  try {
    leadId = await ensureLead({ tenantId, conv, name, requirements, io });
    const pipeline = await ensurePipeline(tenantId);
    const stage = chooseStage(await stagesOf(pipeline.id), sales, reason);
    if (stage) await advanceLeadBySystem({ tenantId, leadId, stageId: stage.id, actor: { id: null, name: RIWO }, io, detail: { reason: REASONS[reason] } });
    if (requirements.length) await noteOnLead({ tenantId, leadId, actor: { id: null, name: RIWO }, type: "requirements", detail: { items: requirements.map(({ question, answer }) => ({ question, answer })), reason } });
  } catch (error) {
    console.error("Sales assistant could not open a lead:", error.message); // the hand-off itself must not fail because of the pipeline
  }

  // 4. a private note for the executive in the chat itself
  const note = [`Riwo ${REASONS[reason]}.`, requirements.length ? `What the customer said:\n${summaryOf(requirements)}` : "No questions were answered yet.", lastText ? `Last message: “${String(lastText).slice(0, 200)}”` : ""].filter(Boolean).join("\n\n");
  await sendTextMessage({ tenantId, conversationId: conv.id, text: note, idempotencyKey: `automation:${execution.id}:sales-note`, agentName: RIWO, type: "internal_note", io }).catch((e) => console.error("Sales note failed:", e.message));

  // 5. the team is told, and a follow-up makes sure someone actually replies
  const who = chatTitle(name, conv.phone);
  const people = await peopleToTell(tenantId, conv);
  await createNotifications({
    io,
    tenantId,
    conversationId: conv.id,
    dedupeKey: `sales-handoff:${execution.id}`,
    recipients: people.map((userId) => ({ userId, type: "handoff" })),
    title: reason === "pricing" ? `${who} wants pricing` : `${who} is ready for an executive`,
    body: (requirements.length ? requirements.map((r) => `${r.answer}`).join(" · ") : lastText || "").replace(/\s+/g, " ").slice(0, 140),
  }).catch((e) => console.error("Sales notice failed:", e.message));
  if (sales.followUpHours > 0) {
    await addSystemTask({
      tenantId,
      leadId,
      conversationId: leadId ? null : conv.id,
      title: reason === "pricing" ? `Send pricing / proposal to ${who}` : `Follow up with ${who}`,
      dueAt: Date.now() + sales.followUpHours * 3600_000,
      assignedUserId: conv.assigned_user_id || null,
      io,
    }).catch((e) => console.error("Sales follow-up failed:", e.message));
  }
  emitForConversation(io, tenantId, conv.id, "home:changed", { conversationId: conv.id });
  emitForConversation(io, tenantId, conv.id, "conversation:updated", { conversationId: conv.id }, { snapshot: true });
  return { leadId };
}
