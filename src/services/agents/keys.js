import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { query } from "../../db/index.js";
import { failWith } from "../../middleware/http.js";
import { planAllows, planOf, isLapsed } from "../plans.js";
import { LEVELS, KEY_PATTERN, AGENT_FEATURE, MAX_AGENTS, DEFAULTS, BOUNDS, CALLS_PER_MINUTE, BAD_KEYS_PER_TEN_MINUTES } from "./config.js";

// An error the agent (or the owner's screen) can act on: what happened, in words, and what to do about it.
// { status, message, code, fix, ...extra }
export const agentError = (status, code, message, fix, extra = {}) => failWith(status, message, { code, fix, ...extra });

// Keys of their own, not api_keys: an API key counts as a manager on routes that do not check scope (services/access.js), and an agent
// must be able to do only what its level says. Only the hash is stored; the key is shown once.
const hash = (key) => crypto.createHash("sha256").update(key).digest("hex");
export const newKeyText = () => `scr_ag_${crypto.randomBytes(20).toString("hex")}`;

const whole = (value, [low, high], label) => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(n) || n < low || n > high)
    throw agentError(400, "invalid_setting", `${label} must be a whole number from ${low} to ${high}.`, `Choose a number between ${low} and ${high}.`);
  return n;
};
const flag = (value, label) => {
  if (typeof value !== "boolean") throw agentError(400, "invalid_setting", `${label} must be true or false.`, "Use the switch on the screen.");
  return value;
};

// What the owner chose, checked. With `partial` only the fields that were sent are returned (an edit); otherwise the defaults fill the rest.
export async function cleanSettings(tenantId, body = {}, { partial = false } = {}) {
  const out = {};
  const sent = (k) => body[k] !== undefined;
  if (!partial || sent("name")) {
    const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 80) throw agentError(400, "invalid_name", "Give the agent a name (up to 80 characters).", "For example: Claude support helper");
    out.name = name;
  }
  if (!partial || sent("level")) {
    if (!LEVELS.includes(body.level)) throw agentError(400, "invalid_level", "Choose what the agent may do: read, reply or full.", "Start with 'reply' for an agent that answers customers, or 'read' to only let it look.");
    out.level = body.level;
  }
  if (!partial || sent("numbers")) {
    const list = body.numbers === undefined || body.numbers === null ? [] : body.numbers;
    if (!Array.isArray(list) || list.length > 50 || list.some((n) => typeof n !== "string" || !n || n.length > 128))
      throw agentError(400, "invalid_numbers", "Choose which numbers the agent may use, or leave the list empty for all of them.", "Pick numbers from the list on the screen.");
    const names = [...new Set(list)];
    if (names.length) {
      const { rows } = await query("SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name = ANY($2::text[])", [tenantId, names]);
      const known = new Set(rows.map((r) => r.session_name));
      const unknown = names.filter((n) => !known.has(n));
      if (unknown.length) throw agentError(400, "unknown_number", `This company has no number called ${unknown.slice(0, 3).map((n) => `"${n}"`).join(", ")}.`, "Pick numbers from the list on the screen.");
    }
    out.sessions = names;
  }
  if (!partial || sent("allowGroups")) out.allow_groups = sent("allowGroups") ? flag(body.allowGroups, "Group chats") : false;
  if (!partial || sent("sharePhones")) out.share_phones = sent("sharePhones") ? flag(body.sharePhones, "Phone numbers") : false;
  if (!partial || sent("disclose")) out.disclose = sent("disclose") ? flag(body.disclose, "The AI line") : true;
  if (!partial || sent("perHour")) out.per_hour = sent("perHour") ? whole(body.perHour, BOUNDS.perHour, "Messages an hour") : DEFAULTS.perHour;
  if (!partial || sent("perDay")) out.per_day = sent("perDay") ? whole(body.perDay, BOUNDS.perDay, "Messages a day") : DEFAULTS.perDay;
  if (!partial || sent("perChatHour")) out.per_chat_hour = sent("perChatHour") ? whole(body.perChatHour, BOUNDS.perChatHour, "Messages to one chat an hour") : DEFAULTS.perChatHour;
  // days from now until the key stops working; null for never
  if (!partial || sent("expiresInDays"))
    out.expires_in_days = sent("expiresInDays") ? (body.expiresInDays === null ? null : whole(body.expiresInDays, BOUNDS.expiresInDays, "Days until the key expires")) : DEFAULTS.expiresInDays;
  return out;
}

const stateOf = (r) => (r.revoked_at ? "revoked" : r.expires_at && new Date(r.expires_at) <= new Date() ? "expired" : "active");

export const agentView = (r, usage = null) => ({
  id: r.id,
  name: r.name,
  level: r.level,
  prefix: r.prefix,
  state: stateOf(r),
  // the numbers it may use; an empty list means every number of the company
  numbers: Array.isArray(r.sessions) ? r.sessions : [],
  allowGroups: Boolean(r.allow_groups),
  sharePhones: Boolean(r.share_phones),
  disclose: Boolean(r.disclose),
  limits: { perHour: r.per_hour, perDay: r.per_day, perChatHour: r.per_chat_hour },
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
  lastClient: r.last_client,
  revokedAt: r.revoked_at,
  ...(usage ? { usage } : {}),
});

export async function createAgentKey({ tenantId, userId = null, ...body }) {
  const s = await cleanSettings(tenantId, body);
  const active = (await query("SELECT count(*)::int AS n FROM agent_keys WHERE tenant_id=$1 AND revoked_at IS NULL", [tenantId])).rows[0].n;
  if (active >= MAX_AGENTS) throw agentError(400, "too_many_agents", `A company can have up to ${MAX_AGENTS} agents.`, "Revoke one you no longer use, then make the new one.");
  const key = newKeyText();
  const id = `agk_${crypto.randomBytes(9).toString("hex")}`;
  const { rows } = await query(
    `INSERT INTO agent_keys(id,tenant_id,name,level,key_hash,prefix,sessions,allow_groups,share_phones,disclose,per_hour,per_day,per_chat_hour,expires_at,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $14::int IS NULL THEN NULL ELSE now() + $14::int * interval '1 day' END,$15) RETURNING *`,
    [id, tenantId, s.name, s.level, hash(key), key.slice(0, 14), JSON.stringify(s.sessions), s.allow_groups, s.share_phones, s.disclose, s.per_hour, s.per_day, s.per_chat_hour, s.expires_in_days, userId],
  );
  return { ...agentView(rows[0]), key };
}

// The agents of a company with what each did lately, newest first. Revoked ones are kept (the owner may want to see them) but only the latest few.
export async function listAgentKeys(tenantId) {
  const [keys, used] = await Promise.all([
    query(
      `(SELECT * FROM agent_keys WHERE tenant_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC)
       UNION ALL (SELECT * FROM agent_keys WHERE tenant_id=$1 AND revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 10)`,
      [tenantId],
    ),
    query(
      `SELECT agent_id,
         count(*) FILTER (WHERE tool='send_message' AND ok IS TRUE AND error_code IS DISTINCT FROM 'duplicate' AND created_at > now() - interval '1 hour')::int AS sent_hour,
         count(*) FILTER (WHERE tool='send_message' AND ok IS TRUE AND error_code IS DISTINCT FROM 'duplicate')::int AS sent_day,
         count(*)::int AS calls_day
       FROM agent_events WHERE tenant_id=$1 AND created_at > now() - interval '24 hours' GROUP BY agent_id`,
      [tenantId],
    ),
  ]);
  const by = new Map(used.rows.map((r) => [r.agent_id, { sentLastHour: r.sent_hour, sentLast24h: r.sent_day, callsLast24h: r.calls_day }]));
  return keys.rows.map((r) => agentView(r, by.get(r.id) || { sentLastHour: 0, sentLast24h: 0, callsLast24h: 0 }));
}

export async function getAgentKey(tenantId, id) {
  const { rows } = await query("SELECT * FROM agent_keys WHERE id=$1 AND tenant_id=$2", [String(id), tenantId]);
  return rows[0] || null;
}

// Changes what an agent may do, or renews its expiry. A revoked key stays revoked.
export async function updateAgentKey(tenantId, id, body = {}) {
  const current = await getAgentKey(tenantId, id);
  if (!current) throw agentError(404, "not_found", "That agent was not found.", "Refresh the page.");
  if (current.revoked_at) throw agentError(409, "key_revoked", "This agent was revoked and cannot be changed.", "Make a new agent instead.");
  const s = await cleanSettings(tenantId, body, { partial: true });
  const sets = [];
  const params = [id, tenantId];
  const put = (col, value) => {
    params.push(value);
    sets.push(`${col}=$${params.length}`);
  };
  for (const col of ["name", "level", "allow_groups", "share_phones", "disclose", "per_hour", "per_day", "per_chat_hour"]) if (s[col] !== undefined) put(col, s[col]);
  if (s.sessions !== undefined) put("sessions", JSON.stringify(s.sessions));
  if ("expires_in_days" in s) {
    params.push(s.expires_in_days);
    sets.push(`expires_at=CASE WHEN $${params.length}::int IS NULL THEN NULL ELSE now() + $${params.length}::int * interval '1 day' END`);
  }
  if (!sets.length) throw agentError(400, "nothing_to_change", "Nothing was changed.", "Send at least one setting.");
  const { rows } = await query(`UPDATE agent_keys SET ${sets.join(",")},updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
  return agentView(rows[0]);
}

export async function revokeAgentKey(tenantId, id, userId = null) {
  const { rowCount } = await query("UPDATE agent_keys SET revoked_at=now(),revoked_by=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL", [String(id), tenantId, userId]);
  return rowCount > 0;
}

// The key as stored, with its company, whatever its state (the caller says why it cannot be used)
export async function findAgentKey(text) {
  if (!KEY_PATTERN.test(String(text ?? ""))) return null;
  const { rows } = await query(
    `SELECT k.*,t.name AS tenant_name,t.status AS tenant_status,t.plan,t.period_end,t.scheduled_plan
       FROM agent_keys k JOIN tenants t ON t.id=k.tenant_id WHERE k.key_hash=$1`,
    [hash(text)],
  );
  return rows[0] || null;
}

// "last used" is only to show a person: once a minute is plenty
function touch(key, userAgent) {
  const stale = !key.last_used_at || Date.now() - new Date(key.last_used_at).getTime() > 60000;
  const client = String(userAgent || "").replace(/\s+/g, " ").trim().slice(0, 80) || null;
  if (stale || (client && client !== key.last_client)) query("UPDATE agent_keys SET last_used_at=now(),last_client=COALESCE($2,last_client) WHERE id=$1", [key.id, client]).catch(() => {});
}

const planProblem = (key) => {
  const company = { plan: key.plan, period_end: key.period_end, scheduled_plan: key.scheduled_plan };
  if (planAllows(company, AGENT_FEATURE)) return null;
  return isLapsed(company)
    ? "AI agent access is switched off because payment for this workspace's plan is overdue."
    : `AI agent access isn't included in the ${planOf(key.plan).name} plan.`;
};

// Wrong, revoked and expired keys from one address are counted (calls that work are not): a few dozen in ten minutes and that address is told to
// wait, so keys cannot be guessed. Runs before the key is looked up.
export const agentAuthLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: BAD_KEYS_PER_TEN_MINUTES,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { status: "error", code: "rate_limited", message: "Too many calls with a wrong key from this address.", fix: "Check the key, then try again in a few minutes." },
});

// After the key is known: one agent cannot flood the server, whatever it is doing
export const agentCallLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: CALLS_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.agent?.id || req.ip,
  validate: false,
  message: { status: "error", code: "rate_limited", message: "This agent is calling too fast.", fix: "Slow down and try again in a few seconds." },
});

// Middleware: the key comes as "Authorization: Bearer scr_ag_..." (or, for the MCP "secret link", as the :key part of the address)
export async function requireAgentKey(req, res, next) {
  try {
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""))?.[1]?.trim();
    const token = bearer || String(req.params?.key || "");
    if (!token) throw agentError(401, "missing_key", "No key was sent.", "Send the agent key as: Authorization: Bearer scr_ag_...");
    const key = await findAgentKey(token);
    if (!key) throw agentError(401, "invalid_key", "This key is not valid.", "Check that all of it was copied. Agent keys are made under Developers, AI agents.");
    if (key.revoked_at) throw agentError(401, "key_revoked", "This key was revoked.", "Ask an owner or admin to make a new agent under Developers, AI agents.");
    if (key.expires_at && new Date(key.expires_at) <= new Date()) throw agentError(401, "key_expired", "This key has expired.", "Ask an owner or admin to renew it under Developers, AI agents.");
    if (key.tenant_status !== "active") throw agentError(403, "workspace_inactive", "This workspace is not active.", "Ask the account owner to check the subscription.");
    const problem = planProblem(key);
    if (problem) throw agentError(403, "plan_required", problem, "Ask the account owner to check the plan.");
    req.agent = key;
    req.tenantId = key.tenant_id;
    touch(key, req.headers["user-agent"]);
    next();
  } catch (error) {
    // an MCP client reads this header to know the key is the problem
    if (error.status === 401) res.set("WWW-Authenticate", 'Bearer realm="Scriwo", error="invalid_token"');
    next(error);
  }
}
