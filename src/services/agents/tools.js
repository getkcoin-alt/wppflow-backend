import crypto from "node:crypto";
import { query, withTransaction } from "../../db/index.js";
import { sendTextMessage } from "../messageService.js";
import { notifyInternalNote, createNotifications } from "../notificationService.js";
import { markConversationRead } from "../conversationService.js";
import { assignConversation } from "../assignmentService.js";
import { syncLeadOwner } from "../leadService.js";
import { applyLabels, listLabels } from "../labelService.js";
import { knowledgeFor } from "../knowledgeService.js";
import { emitForConversation } from "../realtime.js";
import { formatConversation } from "../conversationFormat.js";
import { snippetOf, MIN_CHARS } from "../searchService.js";
import { chatMatch, likeOf } from "../chatMatch.js";
import { chatTitle } from "../personName.js";
import { isOwnNumber } from "../personGuard.js";
import { contactForNumber, chatWithContact } from "../newChat.js";
import { normalizePhone, PHONE_HELP } from "../phone.js";
import { agentError } from "./keys.js";
import { levelAllows, MAX_TEXT, MAX_NOTE, withDisclosure } from "./config.js";
import { recordEvent, reserveSend, reserveNewChat, settleSend, usageOf } from "./activity.js";
import { NOTICE, allowedNumbers, scopeSql, loadChat, titleOf, phoneOf, labelsOf, chatItem, readMessages, clip, isoOf } from "./scope.js";

// What an agent can do. One list of tools, shown three ways: the MCP server (/mcp), a REST mirror (/api/agent/v1/tools) and the OpenAPI
// description built from it (services/agents/openapi.js), so they cannot drift apart. A tool is { name, title, description, level, annotations,
// input, run(ctx, args), describe(args, result) }. `level` is the least level of key that may call it. Nothing here deletes anything, sends a
// broadcast, starts a chat with a stranger, or touches billing, numbers, team, settings or keys.

// ── describing the inputs ────────────────────────────────────────────────────────────────────────
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const num = (description, minimum, maximum, def) => ({ type: "integer", description, minimum, maximum, ...(def !== undefined ? { default: def } : {}) });
const names = (description) => ({ type: "array", description, items: { type: "string" }, maxItems: 20 });
const shape = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const CHAT_ID = str("The chat id, from list_conversations or search_messages.", { maxLength: 64 });
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CHANGE = (extra = {}) => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...extra });

const invalid = (tool, message) =>
  agentError(400, "invalid_input", message, `${tool.name} takes: ${Object.entries(tool.input.properties).map(([k]) => (tool.input.required.includes(k) ? k : `${k}?`)).join(", ") || "no arguments"}.`);

function coerce(tool, key, spec, value) {
  if (spec.type === "string") {
    if (typeof value !== "string") throw invalid(tool, `"${key}" must be text.`);
    const v = value.trim();
    if (spec.minLength && v.length < spec.minLength) throw invalid(tool, `"${key}" must be at least ${spec.minLength} characters.`);
    if (spec.maxLength && v.length > spec.maxLength) throw invalid(tool, `"${key}" must be at most ${spec.maxLength} characters (it has ${v.length}).`);
    if (spec.enum && !spec.enum.includes(v)) throw invalid(tool, `"${key}" must be one of: ${spec.enum.join(", ")}.`);
    return v;
  }
  if (spec.type === "integer") {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (!Number.isInteger(n)) throw invalid(tool, `"${key}" must be a whole number.`);
    if (n < spec.minimum || n > spec.maximum) throw invalid(tool, `"${key}" must be from ${spec.minimum} to ${spec.maximum}.`);
    return n;
  }
  if (spec.type === "boolean") {
    if (typeof value !== "boolean") throw invalid(tool, `"${key}" must be true or false.`);
    return value;
  }
  if (spec.type === "array") {
    if (!Array.isArray(value) || value.length > spec.maxItems) throw invalid(tool, `"${key}" must be a list of up to ${spec.maxItems} names.`);
    return value.map((v) => {
      if (typeof v !== "string" || !v.trim() || v.length > 200) throw invalid(tool, `"${key}" must contain only names.`);
      return v.trim();
    });
  }
  return value;
}

export function validateArgs(tool, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw invalid(tool, "The arguments must be an object.");
  const { properties, required } = tool.input;
  for (const key of Object.keys(args)) if (!(key in properties)) throw invalid(tool, `Unknown argument "${key}".`);
  for (const key of required) if (args[key] === undefined || args[key] === null) throw invalid(tool, `"${key}" is required.`);
  const out = {};
  for (const [key, spec] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined || value === null) {
      if (spec.default !== undefined) out[key] = spec.default;
      continue;
    }
    out[key] = coerce(tool, key, spec, value);
  }
  return out;
}

// ── helpers shared by tools ──────────────────────────────────────────────────────────────────────
const nameOf = (agent) => agent.name;
const actorOf = (agent) => ({ id: null, name: agent.name });

async function teammate(tenantId, name) {
  const wanted = String(name).trim().toLowerCase();
  const { rows } = await query(
    "SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' ORDER BY lower(u.name)",
    [tenantId],
  );
  const found = rows.filter((r) => r.name.trim().toLowerCase() === wanted);
  if (found.length === 1) return found[0];
  const list = rows.slice(0, 15).map((r) => r.name).join(", ");
  if (found.length > 1) throw agentError(409, "ambiguous_name", `More than one teammate is called "${name}".`, "Ask the person which one they mean.");
  throw agentError(404, "unknown_teammate", `There is no active teammate called "${name}".`, `Use list_team. Teammates: ${list || "none"}.`);
}

async function labelIds(tenantId, wanted) {
  const lower = [...new Set(wanted.map((n) => n.toLowerCase()))];
  const { rows } = await query("SELECT id,name FROM labels WHERE tenant_id=$1 AND lower(name) = ANY($2::text[])", [tenantId, lower]);
  const have = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  const missing = wanted.filter((n) => !have.has(n.toLowerCase()));
  if (missing.length) {
    const all = (await listLabels(tenantId)).slice(0, 25).map((l) => l.name).join(", ");
    throw agentError(404, "unknown_label", `No label called ${missing.map((n) => `"${n}"`).join(", ")}.`, `Agents cannot make new labels. Use list_labels. Labels: ${all || "none yet"}.`);
  }
  return rows;
}

const slaMinutes = async (tenantId) => (await query("SELECT sla_minutes FROM report_settings WHERE tenant_id=$1", [tenantId])).rows[0]?.sla_minutes ?? 30;

async function numbersOf(agent) {
  const { rows } = await query(
    `SELECT ws.session_name,ws.status,ws.phone,u.name AS owner FROM whatsapp_sessions ws LEFT JOIN users u ON u.id=ws.owner_user_id
      WHERE ws.tenant_id=$1 ORDER BY ws.created_at,ws.session_name`,
    [agent.tenant_id],
  );
  const mine = allowedNumbers(agent);
  return rows
    .filter((r) => !mine.length || mine.includes(r.session_name))
    .map((r) => ({ name: r.session_name, connected: r.status === "CONNECTED", status: String(r.status || "").toLowerCase(), phone: r.phone ? `+${String(r.phone).replace(/\D/g, "")}` : null, owner: r.owner || null }));
}

// A message that is the same send made twice (a retry) is one send: the same words to the same chat in the same minute, or the same key
function idempotencyFor(agent, conversationId, text, given) {
  if (given !== undefined) return `agent:${agent.id}:${given}`;
  const digest = crypto.createHash("sha256").update(`${conversationId}\n${text}`).digest("hex").slice(0, 24);
  return `agent:${agent.id}:auto:${digest}:${Math.floor(Date.now() / 60000)}`;
}

const emitChat = (io, tenantId, chat) =>
  emitForConversation(io, tenantId, chat.id, "conversation:updated", { conversationId: chat.id, ...formatConversation(chat) }, { snapshot: true });

// The chat a follow-up belongs to, if the agent may see it: the chat it was made from, or the person's latest chat
async function taskRows(agent, { where = "", params = [], limit = 50 } = {}) {
  const p = [agent.tenant_id, ...params];
  const scope = scopeSql(agent, p, "c");
  p.push(limit);
  const { rows } = await query(
    `SELECT t.id,t.title,t.due_at,t.assigned_user_id,u.name AS assigned_name,t.lead_id,ch.id AS chat_id,ch.contact_name,ch.phone,ch.session_name,ch.is_group
       FROM lead_tasks t LEFT JOIN users u ON u.id=t.assigned_user_id
       JOIN LATERAL (
         SELECT c.* FROM conversations c
          WHERE c.tenant_id=t.tenant_id AND (c.id=t.conversation_id OR (t.conversation_id IS NULL AND c.contact_id=(SELECT l.contact_id FROM leads l WHERE l.id=t.lead_id)))${scope}
          ORDER BY (c.id=t.conversation_id) DESC,c.last_active_epoch DESC LIMIT 1
       ) ch ON true
      WHERE t.tenant_id=$1 AND t.done_at IS NULL${where} ORDER BY t.due_at LIMIT $${p.length}`,
    p,
  );
  return rows;
}
const taskItem = (agent, r) => ({
  id: r.id,
  title: r.title,
  dueAt: r.due_at,
  overdue: new Date(r.due_at).getTime() < Date.now(),
  assignedTo: r.assigned_name || null,
  chatId: r.chat_id,
  chat: titleOf(agent, { contact_name: r.contact_name, phone: r.phone, is_group: r.is_group }),
});

// ── the tools ────────────────────────────────────────────────────────────────────────────────────
const FILTERS = ["open", "unread", "waiting_for_reply", "overdue", "needs_human", "unassigned", "closed", "all"];

export const TOOLS = [
  // ── read ──
  {
    name: "get_overview",
    title: "Overview of the inbox",
    description: "Start here. Who you are in this workspace (your level, numbers and limits), the company's WhatsApp numbers, and how many chats need attention.",
    level: "read",
    annotations: READ,
    input: shape(),
    async run({ agent }) {
      const params = [agent.tenant_id];
      const scope = scopeSql(agent, params, "c");
      const sla = await slaMinutes(agent.tenant_id);
      params.push(sla);
      const [counts, numbers, usage] = await Promise.all([
        query(
          `SELECT count(*) FILTER (WHERE c.unread_count>0)::int AS unread,
                  count(*) FILTER (WHERE c.awaiting_since IS NOT NULL AND NOT c.is_closed AND NOT c.is_group)::int AS waiting,
                  count(*) FILTER (WHERE c.awaiting_since IS NOT NULL AND NOT c.is_closed AND NOT c.is_group AND c.awaiting_since < extract(epoch FROM now()) - $${params.length}::int * 60)::int AS overdue,
                  count(*) FILTER (WHERE c.needs_human_since IS NOT NULL AND NOT c.is_closed)::int AS needs_human,
                  count(*) FILTER (WHERE NOT c.is_closed)::int AS open
             FROM conversations c WHERE c.tenant_id=$1${scope}`,
          params,
        ),
        numbersOf(agent),
        usageOf(agent),
      ]);
      const n = counts.rows[0];
      const mine = allowedNumbers(agent);
      return {
        company: agent.tenant_name,
        now: new Date().toISOString(),
        you: {
          name: agent.name,
          level: agent.level,
          numbers: mine.length ? mine : "all",
          groupChats: Boolean(agent.allow_groups),
          customerPhoneNumbers: agent.share_phones ? "visible" : "hidden",
          limits: { messagesPerHour: agent.per_hour, messagesPer24Hours: agent.per_day, messagesPerChatPerHour: agent.per_chat_hour, ...(agent.allow_new_chats ? { newChatsPer24Hours: agent.new_chats_per_day } : {}) },
          mayStartChatsWithNewNumbers: Boolean(agent.allow_new_chats),
          sentLastHour: usage.sentLastHour,
          sentLast24Hours: usage.sentLast24h,
          aiLineAddedToMessages: Boolean(agent.disclose),
        },
        numbers,
        inbox: { openChats: n.open, unreadChats: n.unread, waitingForReply: n.waiting, waitingLongerThanTarget: n.overdue, askedForAPerson: n.needs_human, replyTargetMinutes: sla },
      };
    },
    describe: () => "Looked at the overview",
  },
  {
    name: "list_numbers",
    title: "WhatsApp numbers",
    description: "The company's WhatsApp numbers this agent may use, and whether each is connected. A number that is not connected cannot send.",
    level: "read",
    annotations: READ,
    input: shape(),
    run: async ({ agent }) => ({ numbers: await numbersOf(agent) }),
    describe: (a, r) => `Listed ${r.numbers.length} number(s)`,
  },
  {
    name: "list_conversations",
    title: "List chats",
    description:
      "List chats, most recent activity first. filter: open (default), unread, waiting_for_reply (the customer wrote last, nobody answered), overdue (waiting past the reply target), needs_human, unassigned, closed, all. Narrow by number, assigned_to, label or search (name, phone or words).",
    level: "read",
    annotations: READ,
    input: shape({
      filter: str(`One of: ${FILTERS.join(", ")}.`, { enum: FILTERS, default: "open" }),
      number: str("Only chats on this WhatsApp number (its name, from list_numbers).", { maxLength: 128 }),
      assigned_to: str('A teammate\'s name (from list_team), or "nobody" for chats nobody has.', { maxLength: 100 }),
      label: str("Only chats whose contact has this label (from list_labels).", { maxLength: 100 }),
      search: str("A person's name, a phone number, or words from the chat's last message.", { maxLength: 100 }),
      limit: num("How many chats, 1 to 50.", 1, 50, 20),
      cursor: str("The nextCursor of the previous answer, to get the next page.", { maxLength: 100 }),
    }),
    async run({ agent }, a) {
      const params = [agent.tenant_id];
      let sql = `SELECT c.* FROM conversations c WHERE c.tenant_id=$1${scopeSql(agent, params, "c")}`;
      const mine = allowedNumbers(agent);
      if (a.number) {
        if (mine.length && !mine.includes(a.number)) throw agentError(403, "number_not_allowed", "This agent may not use that number.", "Use list_numbers to see the numbers you may use.");
        params.push(a.number);
        sql += ` AND c.session_name=$${params.length}`;
      }
      const filter = a.filter || "open";
      if (filter === "open") sql += " AND NOT c.is_closed";
      else if (filter === "closed") sql += " AND c.is_closed";
      else if (filter === "unread") sql += " AND c.unread_count>0";
      else if (filter === "unassigned") sql += " AND c.assigned_user_id IS NULL AND NOT c.is_closed";
      else if (filter === "needs_human") sql += " AND c.needs_human_since IS NOT NULL AND NOT c.is_closed";
      else if (filter === "waiting_for_reply" || filter === "overdue") {
        sql += " AND c.awaiting_since IS NOT NULL AND NOT c.is_closed AND NOT c.is_group";
        if (filter === "overdue") {
          params.push(await slaMinutes(agent.tenant_id));
          sql += ` AND c.awaiting_since < extract(epoch FROM now()) - $${params.length}::int * 60`;
        }
      }
      if (a.assigned_to) {
        if (/^(nobody|none|unassigned)$/i.test(a.assigned_to)) sql += " AND c.assigned_user_id IS NULL";
        else {
          params.push((await teammate(agent.tenant_id, a.assigned_to)).id);
          sql += ` AND c.assigned_user_id=$${params.length}`;
        }
      }
      if (a.label) {
        const [label] = await labelIds(agent.tenant_id, [a.label]);
        params.push(label.id);
        sql += ` AND EXISTS (SELECT 1 FROM contact_labels cl WHERE cl.contact_id=c.contact_id AND cl.tenant_id=c.tenant_id AND cl.label_id=$${params.length})`;
      }
      if (a.search) sql += ` AND ${chatMatch(params, a.search.slice(0, 100), "c")}`;
      if (a.cursor) {
        const [epoch, id] = String(a.cursor).split(":");
        if (!id || !Number.isFinite(Number(epoch))) throw agentError(400, "invalid_cursor", "That cursor is not valid.", "Use the nextCursor from the previous answer, unchanged.");
        params.push(Number(epoch), id);
        sql += ` AND (c.last_active_epoch < $${params.length - 1} OR (c.last_active_epoch = $${params.length - 1} AND c.id < $${params.length}))`;
      }
      const limit = a.limit || 20;
      params.push(limit + 1);
      sql += ` ORDER BY c.last_active_epoch DESC, c.id DESC LIMIT $${params.length}`;
      const { rows } = await query(sql, params);
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      const labels = await labelsOf(agent.tenant_id, page.map((c) => c.contact_id));
      const last = page.at(-1);
      return { chats: page.map((c) => chatItem(agent, c, labels.get(c.contact_id) || [])), nextCursor: more && last ? `${last.last_active_epoch}:${last.id}` : null };
    },
    describe: (a, r) => `Listed ${r.chats.length} chat(s) (${a.filter || "open"})`,
  },
  {
    name: "get_conversation",
    title: "Read a chat",
    description: "Everything about one chat: who it is with, labels, the open lead and follow-ups, and the latest messages (oldest first). Does not mark the chat as read.",
    level: "read",
    annotations: READ,
    input: shape({ conversation_id: CHAT_ID, messages: num("How many of the latest messages, 0 to 50.", 0, 50, 30) }, ["conversation_id"]),
    async run({ agent }, a) {
      const chat = await loadChat(agent, a.conversation_id);
      const [labels, contact, lead, tasks, page] = await Promise.all([
        labelsOf(agent.tenant_id, [chat.contact_id]),
        chat.contact_id ? query("SELECT email,tags FROM contacts WHERE id=$1 AND tenant_id=$2", [chat.contact_id, agent.tenant_id]) : { rows: [] },
        chat.contact_id
          ? query(
              `SELECT l.title,l.value,s.name AS stage,u.name AS owner FROM leads l JOIN pipeline_stages s ON s.id=l.stage_id LEFT JOIN users u ON u.id=l.owner_user_id
                WHERE l.tenant_id=$1 AND l.contact_id=$2 AND l.status='open' ORDER BY l.created_at DESC LIMIT 1`,
              [agent.tenant_id, chat.contact_id],
            )
          : { rows: [] },
        query(
          `SELECT t.id,t.title,t.due_at,u.name AS assigned_name FROM lead_tasks t LEFT JOIN users u ON u.id=t.assigned_user_id
            WHERE t.tenant_id=$1 AND t.done_at IS NULL AND (t.conversation_id=$2 OR t.lead_id IN (SELECT l.id FROM leads l WHERE l.tenant_id=$1 AND l.contact_id=$3 AND l.status='open'))
            ORDER BY t.due_at LIMIT 20`,
          [agent.tenant_id, chat.id, chat.contact_id],
        ),
        a.messages === 0 ? { messages: [], nextCursor: null } : readMessages(agent, chat.id, { limit: a.messages ?? 30 }),
      ]);
      const c = contact.rows[0];
      const l = lead.rows[0];
      return {
        notice: NOTICE,
        chat: chatItem(agent, chat, labels.get(chat.contact_id) || []),
        contact: { name: titleOf(agent, chat), ...(agent.share_phones && c?.email ? { email: c.email } : {}), tags: Array.isArray(c?.tags) ? c.tags : [] },
        lead: l ? { title: l.title, stage: l.stage, value: Number(l.value), owner: l.owner || null } : null,
        followUps: tasks.rows.map((t) => ({ id: t.id, title: t.title, dueAt: t.due_at, assignedTo: t.assigned_name || null })),
        messages: page.messages,
        olderMessagesCursor: page.nextCursor,
      };
    },
    describe: () => "Read a chat",
  },
  {
    name: "get_messages",
    title: "Earlier messages of a chat",
    description: "A page of one chat's messages, oldest first. Pass the cursor from get_conversation (olderMessagesCursor) or from the previous page (nextCursor) to go further back.",
    level: "read",
    annotations: READ,
    input: shape({ conversation_id: CHAT_ID, limit: num("How many messages, 1 to 50.", 1, 50, 30), cursor: str("Where to continue from, as given by the previous answer.", { maxLength: 100 }) }, ["conversation_id"]),
    async run({ agent }, a) {
      const chat = await loadChat(agent, a.conversation_id);
      return { notice: NOTICE, chatId: chat.id, ...(await readMessages(agent, chat.id, { limit: a.limit || 30, cursor: a.cursor || null })) };
    },
    describe: (a, r) => `Read ${r.messages.length} message(s)`,
  },
  {
    name: "search_messages",
    title: "Search chats and messages",
    description: "Find chats by a person's name or number, and messages by the words in them. At least 2 characters. Each message hit shows the words around the match.",
    level: "read",
    annotations: READ,
    input: shape({ query: str("What to look for.", { minLength: MIN_CHARS, maxLength: 100 }), number: str("Only on this WhatsApp number.", { maxLength: 128 }), limit: num("How many of each, 1 to 30.", 1, 30, 15) }, ["query"]),
    async run({ agent }, a) {
      const term = a.query;
      const cap = a.limit || 15;
      const mine = allowedNumbers(agent);
      if (a.number && mine.length && !mine.includes(a.number)) throw agentError(403, "number_not_allowed", "This agent may not use that number.", "Use list_numbers to see the numbers you may use.");
      const chatParams = [agent.tenant_id];
      let chatSql = `SELECT c.* FROM conversations c WHERE c.tenant_id=$1${scopeSql(agent, chatParams, "c")}`;
      if (a.number) {
        chatParams.push(a.number);
        chatSql += ` AND c.session_name=$${chatParams.length}`;
      }
      chatSql += ` AND ${chatMatch(chatParams, term, "c")} ORDER BY c.last_active_epoch DESC, c.id DESC LIMIT ${cap}`;
      const chats = (await query(chatSql, chatParams)).rows;
      // words inside messages can take a while on a big inbox: a few seconds, and a slow answer says it is partial
      let partial = false;
      let hits = [];
      try {
        hits = await withTransaction(async (c) => {
          await c.query("SET LOCAL statement_timeout = 4000");
          const params = [agent.tenant_id, likeOf(term)];
          let sql = `SELECT m.id AS message_id,m.text,m.sender,m.timestamp_epoch,c.id AS chat_id,c.contact_name,c.phone,c.is_group
                       FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
                      WHERE m.tenant_id=$1 AND m.type<>'internal_note' AND m.is_deleted IS NOT TRUE AND m.text ILIKE $2 ESCAPE '\\'${scopeSql(agent, params, "c")}`;
          if (a.number) {
            params.push(a.number);
            sql += ` AND c.session_name=$${params.length}`;
          }
          sql += ` ORDER BY m.timestamp_epoch DESC, m.id DESC LIMIT ${cap}`;
          return (await c.query(sql, params)).rows;
        });
      } catch (error) {
        if (error?.code !== "57014") throw error;
        partial = true;
      }
      const labels = await labelsOf(agent.tenant_id, chats.map((c) => c.contact_id));
      return {
        notice: NOTICE,
        chats: chats.map((c) => chatItem(agent, c, labels.get(c.contact_id) || [])),
        messages: hits.map((h) => ({
          chatId: h.chat_id,
          chat: titleOf(agent, { contact_name: h.contact_name, phone: h.phone, is_group: h.is_group }),
          messageId: h.message_id,
          from: h.sender === "agent" ? "us" : "customer",
          at: isoOf(h.timestamp_epoch),
          snippet: snippetOf(h.text, term).text,
        })),
        partial,
      };
    },
    describe: (a, r) => `Searched (${r.chats.length} chat(s), ${r.messages.length} message(s))`,
  },
  {
    name: "list_labels",
    title: "Labels",
    description: "The labels the company uses on contacts, with how many contacts have each. Agents can add and remove these, but cannot make new ones.",
    level: "read",
    annotations: READ,
    input: shape(),
    run: async ({ agent }) => ({ labels: (await listLabels(agent.tenant_id)).map((l) => ({ name: l.name, color: l.color, contacts: l.contacts })) }),
    describe: (a, r) => `Listed ${r.labels.length} label(s)`,
  },
  {
    name: "list_saved_replies",
    title: "Saved replies",
    description: "The team's saved replies (shortcut, title, text). Use their wording when one fits, and adapt it to the chat.",
    level: "read",
    annotations: READ,
    input: shape(),
    run: async ({ agent }) => ({ savedReplies: (await query("SELECT shortcut,title,text FROM canned_replies WHERE tenant_id=$1 ORDER BY shortcut LIMIT 200", [agent.tenant_id])).rows }),
    describe: (a, r) => `Listed ${r.savedReplies.length} saved repl(ies)`,
  },
  {
    name: "list_team",
    title: "Team",
    description: "The teammates (name, role, team, whether available, how many open chats each has). Use the names with assign_conversation and create_task.",
    level: "read",
    annotations: READ,
    input: shape(),
    async run({ agent }) {
      const { rows } = await query(
        `SELECT u.name,m.role,m.category,m.available,
                (SELECT count(*)::int FROM conversations c WHERE c.tenant_id=m.tenant_id AND c.assigned_user_id=u.id AND NOT c.is_closed) AS open_chats
           FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' ORDER BY lower(u.name)`,
        [agent.tenant_id],
      );
      return { team: rows.map((r) => ({ name: r.name, role: r.role, team: r.category, available: Boolean(r.available), openChats: r.open_chats })) };
    },
    describe: (a, r) => `Listed ${r.team.length} teammate(s)`,
  },
  {
    name: "search_knowledge",
    title: "Company knowledge",
    description: "What the company says about itself: its overview, what it offers, the owner's notes, and the website pages that best match your question. Use it before answering a customer about the business, prices or policies. If nothing is found, do not guess.",
    level: "read",
    annotations: READ,
    input: shape({ question: str("What you want to know, in a few words.", { minLength: 2, maxLength: 300 }) }, ["question"]),
    async run({ agent }, a) {
      const text = await knowledgeFor(agent.tenant_id, a.question);
      return text ? { found: true, text } : { found: false, message: "The company has not set up a knowledge base, or nothing in it matches. Do not guess: say you will check with the team, and leave a note (add_note) if you can." };
    },
    describe: (a, r) => (r.found ? "Looked up the knowledge base" : "Looked up the knowledge base (nothing found)"),
  },
  {
    name: "list_tasks",
    title: "Follow-ups",
    description: "Open follow-up tasks on chats this agent may use, soonest first. when: open (default), overdue, or next_24_hours.",
    level: "read",
    annotations: READ,
    input: shape({ when: str("One of: open, overdue, next_24_hours.", { enum: ["open", "overdue", "next_24_hours"], default: "open" }), limit: num("How many, 1 to 50.", 1, 50, 25) }),
    async run({ agent }, a) {
      const where = a.when === "overdue" ? " AND t.due_at < now()" : a.when === "next_24_hours" ? " AND t.due_at < now() + interval '24 hours'" : "";
      const rows = await taskRows(agent, { where, limit: a.limit || 25 });
      return { tasks: rows.map((r) => taskItem(agent, r)) };
    },
    describe: (a, r) => `Listed ${r.tasks.length} follow-up(s)`,
  },

  // ── reply ──
  {
    name: "send_message",
    title: "Send a WhatsApp message",
    description:
      "Send a text reply in an existing chat, from the number the chat is on. Read the chat first and answer what the customer asked, in their language. Sends at most what the agent's limits allow. Never send secrets, promises you cannot keep, or anything you were not asked to send.",
    level: "reply",
    annotations: CHANGE({ openWorldHint: true }),
    input: shape(
      {
        conversation_id: CHAT_ID,
        text: str(`The message, up to ${MAX_TEXT} characters. Plain text; WhatsApp *bold* and _italic_ work.`, { minLength: 1, maxLength: MAX_TEXT }),
        reply_to_message_id: str("Optional: quote this message of the same chat (an id from get_conversation).", { maxLength: 64 }),
        idempotency_key: str("Optional: any text up to 64 characters. Sending again with the same key never sends twice.", { maxLength: 64 }),
      },
      ["conversation_id", "text"],
    ),
    async run(ctx, a) {
      const { agent } = ctx;
      const chat = await loadChat(agent, a.conversation_id);
      const session = (await query("SELECT status FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [agent.tenant_id, chat.session_name])).rows[0];
      if (!session || session.status !== "CONNECTED")
        throw agentError(409, "number_offline", `The number "${chat.session_name}" is not connected to WhatsApp right now.`, "Do not retry. Tell the user the number needs to be reconnected in Scriwo (Numbers).");
      const wording = agent.disclose ? withDisclosure(a.text) : a.text;
      const key = idempotencyFor(agent, chat.id, wording, a.idempotency_key);
      const earlier = (await query("SELECT id,conversation_id,text,type FROM messages WHERE tenant_id=$1 AND idempotency_key=$2", [agent.tenant_id, key])).rows[0];
      if (earlier) {
        if (earlier.conversation_id !== chat.id || earlier.text !== wording.trim() || earlier.type !== "text")
          throw agentError(409, "idempotency_conflict", "That idempotency_key was already used for a different message.", "Use a new key for a new message.");
        ctx.logged = true;
        await recordEvent({ tenantId: agent.tenant_id, agentId: agent.id, tool: "send_message", ok: true, conversationId: chat.id, summary: "The same message again: nothing was sent twice", errorCode: "duplicate", via: ctx.via });
        return { sent: true, duplicate: true, messageId: earlier.id, conversationId: chat.id, note: "This exact message was already sent; nothing was sent again." };
      }
      if (a.reply_to_message_id) {
        const own = await query("SELECT 1 FROM messages WHERE id=$1 AND tenant_id=$2 AND conversation_id=$3", [a.reply_to_message_id, agent.tenant_id, chat.id]);
        if (!own.rowCount) throw agentError(400, "invalid_input", "reply_to_message_id is not a message of this chat.", "Use a message id from get_conversation for this chat, or leave it out.");
      }
      const reservation = await reserveSend(agent, chat.id, { via: ctx.via });
      ctx.logged = true; // the reservation is this call's record; it is settled below
      const started = Date.now();
      try {
        const sent = await sendTextMessage({
          tenantId: agent.tenant_id,
          conversationId: chat.id,
          text: wording,
          idempotencyKey: key,
          agentName: nameOf(agent),
          sentByUserId: null,
          io: ctx.io,
          quotedMessageId: a.reply_to_message_id || null,
          sentVia: "ai_agent",
          audit: { source: "external_agent", ruleRef: `${agent.name} (${agent.id})`, provider: ctx.via === "rest" ? "agent API" : "MCP" },
        });
        // (two identical calls at the same moment: the second finds the first's message, and sends nothing)
        await settleSend(reservation, sent.duplicate
          ? { ok: true, summary: "The same message again: nothing was sent twice", errorCode: "duplicate", ms: Date.now() - started }
          : { ok: true, summary: `Sent a message (${a.text.length} characters)`, ms: Date.now() - started });
        return { sent: true, duplicate: Boolean(sent.duplicate), messageId: sent.message.id, conversationId: chat.id, note: "Queued for WhatsApp. Its delivery status shows on the message (get_messages)." };
      } catch (error) {
        const optedOut = error?.status === 403 && /suppressed/i.test(error.message);
        await settleSend(reservation, { ok: false, summary: optedOut ? "The person has opted out" : "The message was not sent", errorCode: optedOut ? "recipient_opted_out" : error?.extra?.code || `http_${error?.status || 500}`, ms: Date.now() - started });
        if (optedOut) throw agentError(403, "recipient_opted_out", "This person has opted out of messages, so nothing can be sent to them.", "Do not try again. Leave a note for the team if it matters.");
        throw error;
      }
    },
    describe: () => "Sent a message",
  },
  {
    name: "message_new_number",
    title: "Start a chat with a new number",
    description:
      "Start a chat with a phone number the company has not messaged yet and send a first message. Only for a number the user gave you: never guess numbers or message a list. The owner must allow it for this agent, and it has a daily cap. One short, honest message.",
    level: "reply",
    // only offered to an agent whose owner switched it on
    requires: (agent) => Boolean(agent.allow_new_chats),
    annotations: CHANGE({ openWorldHint: true }),
    input: shape(
      {
        phone: str("The person's phone number with the country code, for example +971 50 123 4567. Only a number the user gave you.", { minLength: 6, maxLength: 30 }),
        text: str(`The first message, up to ${MAX_TEXT} characters. Say who you are writing for and why, plainly.`, { minLength: 1, maxLength: MAX_TEXT }),
        number: str("The company's WhatsApp number to send from (its name, from list_numbers). Optional when only one is connected.", { maxLength: 128 }),
        name: str("Their name, if the user told you; it is saved on the new contact.", { maxLength: 100 }),
        idempotency_key: str("Optional: any text up to 64 characters. Sending again with the same key never sends twice.", { maxLength: 64 }),
      },
      ["phone", "text"],
    ),
    async run(ctx, a) {
      const { agent } = ctx;
      const mine = await numbersOf(agent);
      let sessionName = a.number;
      if (sessionName) {
        if (!mine.some((n) => n.name === sessionName)) throw agentError(403, "number_not_allowed", "This agent may not use that number.", "Use list_numbers to see the numbers you may use.");
      } else {
        const live = mine.filter((n) => n.connected);
        if (live.length === 1) sessionName = live[0].name;
        else if (!live.length) throw agentError(409, "number_offline", "None of the numbers this agent may use is connected to WhatsApp right now.", "Do not retry. Tell the user a number needs to be reconnected in Scriwo (Numbers).");
        else throw agentError(400, "invalid_input", `Say which number to send from: ${live.map((n) => n.name).join(", ")}.`, "Pass number with one of those names.");
      }
      const phone = normalizePhone(a.phone);
      if (!phone) throw agentError(400, "invalid_phone", "That is not a phone number with a country code.", PHONE_HELP);
      if (await isOwnNumber(agent.tenant_id, phone)) throw agentError(400, "own_number", "That is one of the company's own WhatsApp numbers.", "Do not message it.");
      const optedOut = (await query("SELECT 1 FROM suppressions WHERE tenant_id=$1 AND phone = ANY($2::text[])", [agent.tenant_id, [phone, `+${phone}`]])).rowCount > 0;
      if (optedOut) throw agentError(403, "recipient_opted_out", "This person has opted out of messages, so nothing can be sent to them.", "Do not try again.");
      const chatFor = async (digits) => (await query("SELECT * FROM conversations WHERE tenant_id=$1 AND session_name=$2 AND provider_chat_id=$3", [agent.tenant_id, sessionName, `${digits}@c.us`])).rows[0];
      const reply = (chat) => TOOL_MAP.get("send_message").run(ctx, { conversation_id: chat.id, text: a.text, idempotency_key: a.idempotency_key });
      const existing = await chatFor(phone);
      if (existing) return { ...(await reply(existing)), startedNewChat: false, note: "A chat with this number already existed, so this went into it like any reply." };

      const reservation = await reserveNewChat(agent, { via: ctx.via });
      ctx.logged = true; // the reservation is this call's record; it is settled below
      const started = Date.now();
      let conversationId = null;
      try {
        const opened = await contactForNumber({ tenantId: agent.tenant_id, sessionName, phone, name: a.name || "", io: ctx.io });
        const already = await chatFor(opened.real);
        if (already) {
          await settleSend(reservation, { ok: false, summary: "A chat with this number already existed", errorCode: "existing_chat", ms: Date.now() - started, conversationId: already.id });
          return { ...(await reply(already)), startedNewChat: false, note: "A chat with this number already existed, so this went into it like any reply." };
        }
        const chat = await chatWithContact({ tenantId: agent.tenant_id, sessionName, contact: opened.contact });
        conversationId = chat.id;
        const sent = await reply(chat);
        await settleSend(reservation, { ok: true, summary: `Started a chat with a new number (${opened.created ? "new contact" : "known contact"})`, ms: Date.now() - started, conversationId });
        return { ...sent, startedNewChat: true, contactCreated: opened.created, note: "WhatsApp may restrict a number that messages people who have not written first. Send nothing more to this person unless they answer or the user asks." };
      } catch (error) {
        await settleSend(reservation, { ok: false, summary: "No chat was started", errorCode: error?.extra?.code || `http_${error?.status || 500}`, ms: Date.now() - started, conversationId });
        throw error;
      }
    },
    describe: () => "Started a chat with a new number",
  },
  {
    name: "add_note",
    title: "Leave a team note",
    description: "Leave an internal note on a chat. Only the team sees it; the customer does not. Use it to hand over, explain what you did, or flag something for a person.",
    level: "reply",
    annotations: CHANGE(),
    input: shape({ conversation_id: CHAT_ID, text: str(`The note, up to ${MAX_NOTE} characters. @Name notifies a teammate.`, { minLength: 1, maxLength: MAX_NOTE }) }, ["conversation_id", "text"]),
    async run({ agent, io }, a) {
      const chat = await loadChat(agent, a.conversation_id);
      const digest = crypto.createHash("sha256").update(`${chat.id}\n${a.text}`).digest("hex").slice(0, 24);
      const result = await sendTextMessage({
        tenantId: agent.tenant_id,
        conversationId: chat.id,
        text: a.text,
        idempotencyKey: `agent:${agent.id}:note:${digest}:${Math.floor(Date.now() / 60000)}`,
        agentName: nameOf(agent),
        sentByUserId: null,
        type: "internal_note",
        io,
        sentVia: "ai_agent",
      });
      if (!result.duplicate)
        notifyInternalNote({ io, tenantId: agent.tenant_id, conversationId: chat.id, messageId: result.message?.id, actor: actorOf(agent), text: a.text }).catch((e) => console.error("Note notification failed:", e.message));
      return { noted: true, duplicate: Boolean(result.duplicate), messageId: result.message.id, conversationId: chat.id };
    },
    describe: () => "Left a team note",
  },
  {
    name: "mark_read",
    title: "Mark a chat as read",
    description: "Clear a chat's unread badge, as a teammate does by opening it. This also tells WhatsApp the messages were seen. Reading a chat with get_conversation never does this.",
    level: "reply",
    annotations: CHANGE({ idempotentHint: true, openWorldHint: true }),
    input: shape({ conversation_id: CHAT_ID }, ["conversation_id"]),
    async run({ agent, io }, a) {
      const chat = await loadChat(agent, a.conversation_id);
      await markConversationRead({ tenantId: agent.tenant_id, conversationId: chat.id, io });
      return { read: true, conversationId: chat.id };
    },
    describe: () => "Marked a chat as read",
  },

  // ── full ──
  {
    name: "assign_conversation",
    title: "Assign a chat to a teammate",
    description: 'Hand a chat to a teammate by name (from list_team), who is told. Use "nobody" to take the chat off whoever has it.',
    level: "full",
    annotations: CHANGE({ idempotentHint: true }),
    input: shape({ conversation_id: CHAT_ID, assignee: str('A teammate\'s name from list_team, or "nobody".', { minLength: 1, maxLength: 100 }) }, ["conversation_id", "assignee"]),
    async run({ agent, io }, a) {
      const chat = await loadChat(agent, a.conversation_id);
      if (/^(nobody|none|unassigned)$/i.test(a.assignee)) {
        const { rows } = await query("UPDATE conversations SET assigned_to='',assigned_user_id=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *", [chat.id, agent.tenant_id]);
        syncLeadOwner({ tenantId: agent.tenant_id, conversation: rows[0], ownerUserId: null, io }).catch((e) => console.error("Lead owner sync failed:", e.message));
        emitChat(io, agent.tenant_id, rows[0]);
        return { assignedTo: null, conversationId: chat.id };
      }
      const who = await teammate(agent.tenant_id, a.assignee);
      const done = await assignConversation({ tenantId: agent.tenant_id, conversationId: chat.id, userId: who.id, actor: actorOf(agent), io });
      if (!done) throw agentError(409, "not_assigned", "The chat could not be assigned.", "Try again, or leave a note for the team.");
      return { assignedTo: who.name, conversationId: chat.id };
    },
    describe: (a) => (/^(nobody|none|unassigned)$/i.test(a.assignee) ? "Took a chat off its owner" : "Assigned a chat"),
  },
  {
    name: "set_status",
    title: "Close or reopen a chat",
    description: "Close a chat that is finished, or reopen one. Closing does not delete anything and the customer is not told.",
    level: "full",
    annotations: CHANGE({ idempotentHint: true }),
    input: shape({ conversation_id: CHAT_ID, status: str("closed or open.", { enum: ["closed", "open"] }) }, ["conversation_id", "status"]),
    async run({ agent, io }, a) {
      const chat = await loadChat(agent, a.conversation_id);
      const { rows } = await query("UPDATE conversations SET is_closed=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *", [chat.id, agent.tenant_id, a.status === "closed"]);
      emitChat(io, agent.tenant_id, rows[0]);
      return { conversationId: chat.id, status: a.status };
    },
    describe: (a) => (a.status === "closed" ? "Closed a chat" : "Reopened a chat"),
  },
  {
    name: "update_labels",
    title: "Add or remove labels",
    description: "Add or remove labels on the person a chat is with. Use the exact names from list_labels; agents cannot create labels.",
    level: "full",
    annotations: CHANGE({ idempotentHint: true }),
    input: shape({ conversation_id: CHAT_ID, add: names("Labels to add."), remove: names("Labels to remove.") }, ["conversation_id"]),
    async run({ agent }, a) {
      const chat = await loadChat(agent, a.conversation_id);
      if (!chat.contact_id) throw agentError(400, "no_contact", "This chat has no contact to label.", "Leave it as it is.");
      if (!(a.add || []).length && !(a.remove || []).length) throw agentError(400, "invalid_input", "Say which labels to add or remove.", "update_labels takes: conversation_id, add?, remove?.");
      const adding = (a.add || []).length ? await labelIds(agent.tenant_id, a.add) : [];
      const removing = (a.remove || []).length ? await labelIds(agent.tenant_id, a.remove) : [];
      const result = await applyLabels(agent.tenant_id, { contactIds: [chat.contact_id], add: adding.map((l) => l.id), remove: removing.map((l) => l.id) });
      return { conversationId: chat.id, added: result.added.map((l) => l.name), removed: result.removed.map((l) => l.name) };
    },
    describe: (a) => `Changed labels (${(a.add || []).length} added, ${(a.remove || []).length} removed)`,
  },
  {
    name: "create_task",
    title: "Create a follow-up",
    description: "Create a follow-up task on a chat (not a group), due at a time you give: due_at as an ISO 8601 date-time, or due_in_hours. Optionally give it to a teammate by name; otherwise it goes to the chat's owner.",
    level: "full",
    annotations: CHANGE(),
    input: shape(
      {
        conversation_id: CHAT_ID,
        title: str("What to follow up on, up to 255 characters.", { minLength: 1, maxLength: 255 }),
        due_at: str("When it is due, ISO 8601, for example 2026-11-20T10:00:00+05:30.", { maxLength: 40 }),
        due_in_hours: num("Or: due this many hours from now, 1 to 720.", 1, 720),
        assignee: str("A teammate's name from list_team.", { maxLength: 100 }),
      },
      ["conversation_id", "title"],
    ),
    async run({ agent, io }, a) {
      const chat = await loadChat(agent, a.conversation_id);
      if (chat.is_group) throw agentError(400, "not_for_groups", "A follow-up is for a person, not a group.", "Leave a note instead.");
      let due;
      if (a.due_at) due = new Date(a.due_at);
      else if (a.due_in_hours) due = new Date(Date.now() + a.due_in_hours * 3600_000);
      if (!due || !Number.isFinite(due.getTime())) throw agentError(400, "invalid_input", "Say when it is due: due_at (ISO 8601) or due_in_hours.", "For example due_in_hours: 24.");
      const who = a.assignee ? await teammate(agent.tenant_id, a.assignee) : null;
      const owner = who?.id ?? chat.assigned_user_id ?? (await query("SELECT owner_user_id FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [agent.tenant_id, chat.session_name])).rows[0]?.owner_user_id ?? null;
      const id = crypto.randomUUID();
      await query("INSERT INTO lead_tasks(id,tenant_id,lead_id,conversation_id,title,due_at,assigned_user_id,created_by) VALUES($1,$2,NULL,$3,$4,$5,$6,NULL)", [id, agent.tenant_id, chat.id, a.title, due.toISOString(), owner]);
      if (owner)
        await createNotifications({
          io,
          tenantId: agent.tenant_id,
          actor: actorOf(agent),
          conversationId: chat.id,
          dedupeKey: `task-assigned:${id}:${owner}`,
          recipients: [{ userId: owner, type: "lead_task" }],
          title: `New follow-up assigned: ${a.title}`,
          body: `${agent.name} (an AI agent) added a follow-up for ${chatTitle(chat.contact_name, chat.phone) || "this chat"}.`,
        }).catch((e) => console.error("Follow-up notice failed:", e.message));
      return { created: true, taskId: id, dueAt: due.toISOString(), conversationId: chat.id };
    },
    describe: () => "Created a follow-up",
  },
  {
    name: "complete_task",
    title: "Finish a follow-up",
    description: "Mark a follow-up task as done (ids from list_tasks or get_conversation).",
    level: "full",
    annotations: CHANGE({ idempotentHint: true }),
    input: shape({ task_id: str("The follow-up's id.", { maxLength: 64 }) }, ["task_id"]),
    async run({ agent }, a) {
      const [task] = await taskRows(agent, { where: " AND t.id=$2", params: [a.task_id], limit: 1 });
      if (!task) throw agentError(404, "not_found", "That follow-up was not found, or it is already done.", "Use list_tasks to see the open ones.");
      await query("UPDATE lead_tasks SET done_at=now() WHERE id=$1 AND tenant_id=$2 AND done_at IS NULL", [task.id, agent.tenant_id]);
      return { done: true, taskId: task.id, chatId: task.chat_id };
    },
    describe: () => "Finished a follow-up",
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// The tools a key may call, as clients want them: { name, title, description, inputSchema, annotations }
export const inputSchemaOf = (tool) => {
  const { properties, required } = tool.input;
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
};
export const toolsFor = (agent) =>
  TOOLS.filter((t) => levelAllows(agent.level, t.level) && (!t.requires || t.requires(agent))).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: inputSchemaOf(t), annotations: t.annotations }));

// What a caller is told about an error. Messages written for people are passed on; anything else is only logged.
export function publicError(error) {
  if (error?.extra?.code) return { status: error.status || 400, code: error.extra.code, message: error.message, fix: error.extra.fix || "", ...(error.extra.retryAfter ? { retryAfter: error.extra.retryAfter } : {}) };
  if (error?.status && error.status < 500) {
    const code = { 400: "invalid_input", 403: "not_allowed", 404: "not_found", 409: "conflict", 429: "rate_limited" }[error.status] || "rejected";
    return { status: error.status, code, message: error.message, fix: "" };
  }
  console.error("Agent tool failed:", error?.message);
  return { status: 500, code: "internal_error", message: "Something went wrong on Scriwo's side.", fix: "Try again in a moment. If it keeps failing, tell the user." };
}

// Runs one tool for an agent: level, arguments, the work, and the record of it. Throws what publicError describes.
export async function runTool({ agent, name, args = {}, io = null, via = "mcp" }) {
  const tool = TOOL_MAP.get(name);
  const ctx = { agent, io, via, logged: false };
  const started = Date.now();
  let input = {};
  let result;
  let failure;
  try {
    if (!tool) throw agentError(404, "unknown_tool", `There is no tool called "${clip(name, 60)}".`, "List the tools and use one of those names.");
    if (!levelAllows(agent.level, tool.level))
      throw agentError(403, "level_too_low", `This agent's level is "${agent.level}", and ${name} needs "${tool.level}".`, "Do not retry. An owner or admin can change the level under Developers, AI agents.");
    if (tool.requires && !tool.requires(agent))
      throw agentError(403, "new_chats_off", `${name} is not allowed for this agent.`, "Do not retry. An owner or admin can allow starting chats with new numbers for this agent under Developers, AI agents.");
    input = validateArgs(tool, args);
    result = await tool.run(ctx, input);
  } catch (error) {
    failure = error;
  }
  if (!ctx.logged) {
    const problem = failure ? publicError(failure) : null;
    await recordEvent({
      tenantId: agent.tenant_id,
      agentId: agent.id,
      tool: tool ? name : "unknown_tool",
      ok: !failure,
      conversationId: typeof input.conversation_id === "string" ? input.conversation_id : null,
      summary: failure ? problem.message : tool.describe(input, result),
      errorCode: problem?.code || null,
      ms: Date.now() - started,
      via,
    });
  }
  if (failure) throw failure;
  return result;
}
