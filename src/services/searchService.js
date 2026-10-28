import { query, withTransaction } from "../db/index.js";
import { formatConversation, withLabels } from "./conversationService.js";
import { chatMatch, digitsOf, likeOf } from "./chatMatch.js";

// Searching the inbox the way WhatsApp does: by the person's name or number (the number in any format: "+91 98100 11122",
// "9810011122", "98100-11122"), and by the words inside messages, each hit shown with the words around it.

export const MIN_CHARS = 2;
// The words around the first match, cut at word edges and marked with … where text was left out.
export function snippetOf(text, term, radius = 48) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return { text: flat.slice(0, radius * 2), start: -1, length: 0 };
  let from = Math.max(0, at - radius);
  let to = Math.min(flat.length, at + term.length + radius);
  if (from > 0) {
    const space = flat.indexOf(" ", from);
    if (space !== -1 && space < at) from = space + 1;
  }
  if (to < flat.length) {
    const space = flat.lastIndexOf(" ", to);
    if (space > at + term.length) to = space;
  }
  const lead = from > 0 ? "…" : "";
  const out = `${lead}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
  return { text: out, start: lead.length + (at - from), length: term.length };
}

export async function searchInbox({ tenantId, ownerUserId = null, text = "", sessionName = null, limit = 30 }) {
  const term = String(text ?? "").trim().slice(0, 100);
  if (term.length < MIN_CHARS) return { query: term, chats: [], messages: [], partial: false };
  const cap = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 50);

  // who may see which chats: the same rule as the chat list
  const visible = (params) => {
    let sql = ` AND c.provider_chat_id !~ '@(broadcast|newsletter)$'`;
    if (sessionName) {
      params.push(sessionName);
      sql += ` AND c.session_name=$${params.length}`;
    }
    if (ownerUserId) {
      params.push(ownerUserId);
      sql += ` AND (c.session_name IN (SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 AND owner_user_id=$${params.length}) OR c.assigned_user_id=$${params.length})`;
    }
    return sql;
  };

  const chatParams = [tenantId];
  const chatSql = `SELECT c.* FROM conversations c WHERE c.tenant_id=$1${visible(chatParams)} AND ${chatMatch(chatParams, term, "c")}
    ORDER BY c.last_active_epoch DESC, c.id DESC LIMIT ${cap}`;
  const chats = await withLabels(tenantId, (await query(chatSql, chatParams)).rows.map(formatConversation));

  // message text can be a lot to read: it is given a few seconds, and a slow answer says it is partial
  let partial = false;
  let rows = [];
  try {
    rows = await withTransaction(async (c) => {
      await c.query("SET LOCAL statement_timeout = 4000");
      const params = [tenantId, likeOf(term)];
      const sql = `SELECT m.id AS message_id, m.text, m.file_name, m.sender, m.timestamp_epoch, c.*
        FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
        WHERE m.tenant_id=$1 AND m.type<>'internal_note' AND (m.text ILIKE $2 ESCAPE '\\' OR m.file_name ILIKE $2 ESCAPE '\\')${visible(params)}
        ORDER BY m.timestamp_epoch DESC, m.id DESC LIMIT ${cap}`;
      return (await c.query(sql, params)).rows;
    });
  } catch (error) {
    if (error?.code !== "57014") throw error;
    partial = true;
  }
  const labelled = await withLabels(tenantId, rows.map(formatConversation));
  const messages = rows.map((r, i) => {
    const source = r.text && r.text.toLowerCase().includes(term.toLowerCase()) ? r.text : r.file_name || r.text;
    return {
      messageId: r.message_id,
      conversationId: r.id,
      fromMe: r.sender === "agent",
      timestampEpoch: Number(r.timestamp_epoch || 0),
      snippet: snippetOf(source, term),
      chat: labelled[i],
    };
  });
  return { query: term, chats, messages, partial };
}

