import { query } from "../db/index.js";
import { chatTitle } from "./personName.js";
import { fail } from "../middleware/http.js";
import { createNotifications } from "./notificationService.js";
import { sendEmail } from "./emailService.js";

// How fast the team answers. A customer's message starts a wait; the next reply from a person on the team ends it.
// What does not count as a reply: team notes, replies sent by an automation or a broadcast, and anything in a group.
// Times are wall-clock, so a message sent at night is answered "late" in the morning: say so wherever it is shown.
export const MIN_SAMPLE = 5; // fewer answered chats than this and a median means little, so none is shown
const DAY = 86400;
const MAX_DAYS = 92;
const LOOKBACK_DAYS = 14; // a wait that began before the range still ends inside it
const AUTOMATIC = ["Automation", "Campaign"];

const epochOf = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
const isoOfEpoch = (e) => new Date(e * 1000).toISOString().slice(0, 10);
const validDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && isoOfEpoch(epochOf(v)) === v;

export function parseRange({ from, to } = {}, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const end = to ?? today;
  const start = from ?? isoOfEpoch(epochOf(end) - 29 * DAY);
  if (!validDay(start) || !validDay(end)) throw fail(400, "Dates must be written as YYYY-MM-DD");
  if (end < start) throw fail(400, "The end date is before the start date");
  if ((epochOf(end) - epochOf(start)) / DAY + 1 > MAX_DAYS) throw fail(400, `A report covers at most ${MAX_DAYS} days`);
  return { from: start, to: end, fromEpoch: epochOf(start), toEpoch: epochOf(end) + DAY };
}

export const median = (sorted) => {
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? sorted[(n - 1) / 2] : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
};
export const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);
const stats = (seconds) => {
  const s = [...seconds].sort((a, b) => a - b);
  const enough = s.length >= MIN_SAMPLE;
  return {
    answered: s.length,
    enoughData: enough,
    medianSeconds: enough ? median(s) : null,
    p90Seconds: enough ? percentile(s, 0.9) : null,
    meanSeconds: enough ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null,
  };
};

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

export async function getSettings(tenantId) {
  const [row, teams] = await Promise.all([
    query("SELECT * FROM report_settings WHERE tenant_id=$1", [tenantId]),
    query("SELECT team,sla_minutes FROM team_sla WHERE tenant_id=$1 ORDER BY team", [tenantId]),
  ]);
  const r = row.rows[0];
  return {
    slaMinutes: r?.sla_minutes ?? 30,
    dailyInApp: r?.daily_in_app ?? true,
    dailyEmail: r?.daily_email ?? false,
    // hours a follow-up may stay overdue before the owner and administrators are told; 0 switches it off
    taskEscalationHours: r?.task_escalation_hours ?? 24,
    teams: Object.fromEntries(teams.rows.map((t) => [t.team, t.sla_minutes])),
  };
}
const minutes = (v, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10080) throw fail(400, `${label} must be a whole number of minutes from 1 to 10080`);
  return n;
};
export async function saveSettings(tenantId, body = {}) {
  const current = await getSettings(tenantId);
  const next = {
    slaMinutes: body.slaMinutes === undefined ? current.slaMinutes : minutes(body.slaMinutes, "The reply target"),
    dailyInApp: body.dailyInApp === undefined ? current.dailyInApp : Boolean(body.dailyInApp),
    dailyEmail: body.dailyEmail === undefined ? current.dailyEmail : Boolean(body.dailyEmail),
    taskEscalationHours: current.taskEscalationHours,
  };
  if (body.taskEscalationHours !== undefined) {
    const h = Number(body.taskEscalationHours);
    if (!Number.isInteger(h) || h < 0 || h > 720) throw fail(400, "The escalation time must be a whole number of hours from 0 to 720 (0 switches it off)");
    next.taskEscalationHours = h;
  }
  await query(
    `INSERT INTO report_settings(tenant_id,sla_minutes,daily_in_app,daily_email,task_escalation_hours) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(tenant_id) DO UPDATE SET sla_minutes=EXCLUDED.sla_minutes,daily_in_app=EXCLUDED.daily_in_app,daily_email=EXCLUDED.daily_email,task_escalation_hours=EXCLUDED.task_escalation_hours,updated_at=now()`,
    [tenantId, next.slaMinutes, next.dailyInApp, next.dailyEmail, next.taskEscalationHours],
  );
  if (body.teams !== undefined) {
    if (!body.teams || typeof body.teams !== "object" || Array.isArray(body.teams)) throw fail(400, "Teams must be an object of team to minutes");
    await query("DELETE FROM team_sla WHERE tenant_id=$1", [tenantId]);
    for (const [team, value] of Object.entries(body.teams)) {
      if (value === null || value === "") continue; // no override: the company default applies
      await query("INSERT INTO team_sla(tenant_id,team,sla_minutes) VALUES($1,$2,$3)", [tenantId, String(team).slice(0, 40), minutes(value, `The target for ${team}`)]);
    }
  }
  return getSettings(tenantId);
}

// ── Who is who ───────────────────────────────────────────────────────────────────────────────────

async function directory(tenantId) {
  const [members, sessions] = await Promise.all([
    query("SELECT u.id,u.name,m.category,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1", [tenantId]),
    query("SELECT session_name,owner_user_id,phone FROM whatsapp_sessions WHERE tenant_id=$1", [tenantId]),
  ]);
  const byId = new Map(members.rows.map((m) => [m.id, { id: m.id, name: m.name, team: m.category || "general" }]));
  const byName = new Map();
  for (const m of byId.values()) (byName.get(m.name.trim().toLowerCase()) || byName.set(m.name.trim().toLowerCase(), []).get(m.name.trim().toLowerCase())).push(m);
  const owners = new Map(sessions.rows.map((s) => [s.session_name, s.owner_user_id]));
  const unknown = (name) => ({ id: null, name: name || "Sent from a phone", team: "general" });
  // Who a reply is credited to: the teammate who sent it from Scriwo; else the one person with that name; else the
  // owner of the WhatsApp number it went out on (a reply typed on the phone itself).
  const who = ({ userId, name, session }) => {
    if (userId && byId.has(userId)) return byId.get(userId);
    const named = byName.get(String(name || "").trim().toLowerCase());
    if (named?.length === 1) return named[0];
    const owner = owners.get(session);
    if (owner && byId.has(owner)) return byId.get(owner);
    return unknown(name);
  };
  return { byId, who, owners, teams: [...new Set([...byId.values()].map((m) => m.team))].sort() };
}

// ── Reply times ──────────────────────────────────────────────────────────────────────────────────

// One row per wait: when the customer first wrote after the last reply, and when (if ever) a person answered.
async function episodes({ tenantId, fromEpoch, toEpoch, sessionName = null }) {
  const { rows } = await query(
    `WITH base AS (
       SELECT m.conversation_id,m.timestamp_epoch AS ts,m.created_at,m.id,m.sent_by_user_id,m.agent_name,
              CASE WHEN m.sender='customer' THEN 'c'
                   WHEN m.sender='agent' AND m.type<>'internal_note' AND m.agent_name<>ALL($5::text[]) THEN 'h' END AS kind
       FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
       WHERE m.tenant_id=$1 AND NOT c.is_group AND c.provider_chat_id !~ '@(broadcast|newsletter)$'
         AND m.timestamp_epoch >= $2::bigint - $6::int*86400 AND m.timestamp_epoch < $3::bigint
         AND ($4::text IS NULL OR c.session_name=$4)
     ), typed AS (SELECT * FROM base WHERE kind IS NOT NULL),
     grouped AS (
       SELECT *,COALESCE(SUM((kind='h')::int) OVER (PARTITION BY conversation_id ORDER BY ts,created_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS grp FROM typed
     ), waits AS (
       SELECT conversation_id,grp,
              MIN(ts) FILTER (WHERE kind='c') AS asked,
              (array_agg(ts ORDER BY ts,created_at,id) FILTER (WHERE kind='h'))[1] AS replied,
              (array_agg(sent_by_user_id ORDER BY ts,created_at,id) FILTER (WHERE kind='h'))[1] AS by_user,
              (array_agg(agent_name ORDER BY ts,created_at,id) FILTER (WHERE kind='h'))[1] AS by_name
       FROM grouped GROUP BY conversation_id,grp HAVING MIN(ts) FILTER (WHERE kind='c') IS NOT NULL
     )
     SELECT w.*,c.session_name,c.contact_name,c.phone,c.is_closed,c.assigned_user_id,c.assigned_to
     FROM waits w JOIN conversations c ON c.id=w.conversation_id
     WHERE w.asked >= $2::bigint AND w.asked < $3::bigint
     ORDER BY w.asked`,
    [tenantId, fromEpoch, toEpoch, sessionName, AUTOMATIC, LOOKBACK_DAYS],
  );
  return rows;
}

const slaOf = (settings, team) => (settings.teams[team] ?? settings.slaMinutes) * 60;

export async function teamResponse(tenantId, { from, to, team = "", sessionName = "", now = Date.now() } = {}) {
  const range = parseRange({ from, to }, now);
  const [people, settings, rows, sent] = await Promise.all([
    directory(tenantId),
    getSettings(tenantId),
    episodes({ tenantId, fromEpoch: range.fromEpoch, toEpoch: range.toEpoch, sessionName: sessionName || null }),
    query(
      `SELECT m.sent_by_user_id AS user_id,m.agent_name,c.session_name,count(*)::int AS n
       FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE m.tenant_id=$1 AND m.sender='agent' AND m.type<>'internal_note' AND m.agent_name<>ALL($5::text[]) AND NOT c.is_group
         AND m.timestamp_epoch >= $2 AND m.timestamp_epoch < $3 AND ($4::text IS NULL OR c.session_name=$4)
       GROUP BY 1,2,3`,
      [tenantId, range.fromEpoch, range.toEpoch, sessionName || null, AUTOMATIC],
    ),
  ]);
  const nowSec = Math.floor(now / 1000);
  const agents = new Map();
  const slot = (p) => {
    const key = p.id ?? `name:${p.name}`;
    if (!agents.has(key)) agents.set(key, { userId: p.id, name: p.name, team: p.team, seconds: [], within: 0, chats: new Set(), replies: 0 });
    return agents.get(key);
  };
  const days = new Map();
  const waiting = [];
  const all = [];
  for (const r of rows) {
    if (r.replied === null || r.replied === undefined) {
      if (r.is_closed) continue; // a resolved chat is not waiting
      const owner = r.assigned_user_id ? people.byId.get(r.assigned_user_id) : people.byId.get(people.owners.get(r.session_name));
      if (team && (owner?.team || "general") !== team) continue;
      waiting.push({
        conversationId: r.conversation_id,
        contact: chatTitle(r.contact_name, r.phone),
        session: r.session_name,
        assignedTo: r.assigned_to || owner?.name || "",
        since: new Date(Number(r.asked) * 1000).toISOString(),
        waitingSeconds: Math.max(0, nowSec - Number(r.asked)),
      });
      continue;
    }
    const seconds = Number(r.replied) - Number(r.asked);
    if (seconds < 0) continue;
    const p = people.who({ userId: r.by_user, name: r.by_name, session: r.session_name });
    if (team && p.team !== team) continue;
    const a = slot(p);
    a.seconds.push(seconds);
    a.chats.add(r.conversation_id);
    if (seconds <= slaOf(settings, p.team)) a.within++;
    const day = isoOfEpoch(Number(r.asked));
    (days.get(day) || days.set(day, []).get(day)).push(seconds);
    all.push({ seconds, within: seconds <= slaOf(settings, p.team) });
  }
  for (const s of sent.rows) {
    const p = people.who({ userId: s.user_id, name: s.agent_name, session: s.session_name });
    if (team && p.team !== team) continue;
    slot(p).replies += s.n;
  }
  const list = [...agents.values()]
    .map((a) => ({
      userId: a.userId,
      name: a.name,
      team: a.team,
      ...stats(a.seconds),
      withinSlaPercent: a.seconds.length >= MIN_SAMPLE ? Math.round((a.within / a.seconds.length) * 100) : null,
      chatsHandled: a.chats.size,
      repliesSent: a.replies,
      slaMinutes: slaOf(settings, a.team) / 60,
    }))
    // fastest median first among people with enough answered chats; the rest follow by how many they answered
    .sort((x, y) => (x.enoughData === y.enoughData ? (x.enoughData ? x.medianSeconds - y.medianSeconds : y.answered - x.answered) : x.enoughData ? -1 : 1))
    .map((a, i) => ({ rank: a.enoughData ? i + 1 : null, ...a }));
  const overall = stats(all.map((x) => x.seconds));
  waiting.sort((a, b) => b.waitingSeconds - a.waitingSeconds);
  return {
    range: { from: range.from, to: range.to },
    filters: { team, sessionName },
    timeNote: "Times are wall-clock: a message sent at night counts until someone answers in the morning.",
    minSample: MIN_SAMPLE,
    settings,
    teams: people.teams,
    totals: {
      ...overall,
      withinSlaPercent: overall.enoughData ? Math.round((all.filter((x) => x.within).length / all.length) * 100) : null,
      waiting: waiting.length,
    },
    agents: list,
    waiting: waiting.slice(0, 100),
    daily: [...days.entries()].sort().map(([date, secs]) => ({ date, ...stats(secs) })),
  };
}

// Every wait behind one person's numbers, so a figure can be checked against the chats it came from.
export async function agentEpisodes(tenantId, { userId, from, to, sessionName = "", now = Date.now() }) {
  const range = parseRange({ from, to }, now);
  const [people, rows] = await Promise.all([directory(tenantId), episodes({ tenantId, fromEpoch: range.fromEpoch, toEpoch: range.toEpoch, sessionName: sessionName || null })]);
  const out = [];
  for (const r of rows) {
    if (r.replied === null || r.replied === undefined) continue;
    const p = people.who({ userId: r.by_user, name: r.by_name, session: r.session_name });
    if (String(p.id) !== String(userId)) continue;
    out.push({
      conversationId: r.conversation_id,
      contact: chatTitle(r.contact_name, r.phone),
      session: r.session_name,
      asked: new Date(Number(r.asked) * 1000).toISOString(),
      replied: new Date(Number(r.replied) * 1000).toISOString(),
      seconds: Number(r.replied) - Number(r.asked),
    });
  }
  return out.reverse().slice(0, 200);
}

const cell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  // a value that starts like a formula would run in a spreadsheet: keep it as text
  return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
export function leaderboardCsv(report) {
  return toCsv([
    ["Rank", "Name", "Team", "Chats answered", "Median reply (seconds)", "90% answered within (seconds)", "Average (seconds)", `Within target (%)`, "Target (minutes)", "Chats handled", "Replies sent", "From", "To"],
    ...report.agents.map((a) => [a.rank, a.name, a.team, a.answered, a.medianSeconds, a.p90Seconds, a.meanSeconds, a.withinSlaPercent, a.slaMinutes, a.chatsHandled, a.repliesSent, report.range.from, report.range.to]),
  ]);
}
export const episodesCsv = (rows) => toCsv([["Customer", "Number", "Customer wrote", "Answered", "Seconds"], ...rows.map((r) => [r.contact, r.session, r.asked, r.replied, r.seconds])]);

// ── The owner's daily report ─────────────────────────────────────────────────────────────────────

// One day, by number and by team, with the figures that matter to an owner in the morning.
export async function dailySummary(tenantId, date, now = Date.now()) {
  if (!validDay(date)) throw fail(400, "Dates must be written as YYYY-MM-DD");
  const from = epochOf(date),
    to = from + DAY;
  const [people, flow, started, sessions] = await Promise.all([
    directory(tenantId),
    query(
      `SELECT c.session_name,
              count(*) FILTER (WHERE m.sender='customer')::int AS received,
              count(*) FILTER (WHERE m.sender='agent' AND m.type<>'internal_note' AND m.agent_name<>ALL($4::text[]))::int AS replied,
              count(DISTINCT m.conversation_id) FILTER (WHERE m.sender='customer')::int AS chats
       FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE m.tenant_id=$1 AND NOT c.is_group AND m.timestamp_epoch >= $2 AND m.timestamp_epoch < $3 GROUP BY c.session_name`,
      [tenantId, from, to, AUTOMATIC],
    ),
    query("SELECT session_name,count(*)::int AS n FROM conversations WHERE tenant_id=$1 AND NOT is_group AND created_at >= to_timestamp($2) AND created_at < to_timestamp($3) GROUP BY 1", [tenantId, from, to]),
    query("SELECT session_name,owner_user_id,phone FROM whatsapp_sessions WHERE tenant_id=$1", [tenantId]),
  ]);
  const report = await teamResponse(tenantId, { from: date, to: date, now });
  const startedBy = new Map(started.rows.map((r) => [r.session_name, r.n]));
  const numbers = sessions.rows.map((s) => {
    const f = flow.rows.find((r) => r.session_name === s.session_name);
    const owner = people.byId.get(s.owner_user_id);
    return { session: s.session_name, label: owner?.name || (s.phone ? `+${String(s.phone).replace(/\D/g, "")}` : s.session_name), team: owner?.team || "general", newChats: startedBy.get(s.session_name) || 0, chatsActive: f?.chats || 0, received: f?.received || 0, replied: f?.replied || 0 };
  });
  const teams = {};
  for (const a of report.agents) {
    const t = (teams[a.team] ||= { team: a.team, answered: 0, repliesSent: 0, people: 0 });
    t.answered += a.answered;
    t.repliesSent += a.repliesSent;
    t.people += 1;
  }
  const top = report.agents.filter((a) => a.answered > 0).sort((a, b) => b.answered - a.answered)[0] || null;
  return {
    date,
    newChats: numbers.reduce((n, x) => n + x.newChats, 0),
    received: numbers.reduce((n, x) => n + x.received, 0),
    replied: numbers.reduce((n, x) => n + x.replied, 0),
    answered: report.totals.answered,
    medianSeconds: report.totals.medianSeconds,
    withinSlaPercent: report.totals.withinSlaPercent,
    waitingNow: (await teamResponse(tenantId, { from: isoOfEpoch(Math.floor(now / 1000) - 7 * DAY), to: isoOfEpoch(Math.floor(now / 1000)), now })).totals.waiting,
    topAgent: top && { name: top.name, answered: top.answered },
    numbers,
    teams: Object.values(teams),
    agents: report.agents,
  };
}

// Every chat that had activity on a day, optionally for one number, team or person: the list behind a figure.
export async function dailyChats(tenantId, { date, sessionName = "", team = "", userId = "" }) {
  if (!validDay(date)) throw fail(400, "Dates must be written as YYYY-MM-DD");
  const from = epochOf(date);
  const [people, rows] = await Promise.all([
    directory(tenantId),
    query(
      `SELECT c.id,c.contact_name,c.phone,c.session_name,c.assigned_to,c.assigned_user_id,
              count(*) FILTER (WHERE m.sender='customer')::int AS received,
              count(*) FILTER (WHERE m.sender='agent' AND m.type<>'internal_note' AND m.agent_name<>ALL($5::text[]))::int AS replied,
              max(m.timestamp_epoch) AS last_at,
              (array_agg(m.sent_by_user_id ORDER BY m.timestamp_epoch) FILTER (WHERE m.sender='agent' AND m.type<>'internal_note' AND m.agent_name<>ALL($5::text[])))[1] AS by_user,
              (array_agg(m.agent_name ORDER BY m.timestamp_epoch) FILTER (WHERE m.sender='agent' AND m.type<>'internal_note' AND m.agent_name<>ALL($5::text[])))[1] AS by_name
       FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE m.tenant_id=$1 AND NOT c.is_group AND m.timestamp_epoch >= $2 AND m.timestamp_epoch < $3 AND ($4::text='' OR c.session_name=$4)
       GROUP BY c.id ORDER BY max(m.timestamp_epoch) DESC LIMIT 300`,
      [tenantId, from, from + DAY, sessionName, AUTOMATIC],
    ),
  ]);
  return rows.rows
    .map((r) => ({ r, p: r.replied ? people.who({ userId: r.by_user, name: r.by_name, session: r.session_name }) : null }))
    .filter(({ r, p }) => (!team || (p ? p.team === team : (people.byId.get(r.assigned_user_id) || people.byId.get(people.owners.get(r.session_name)) || {}).team === team)) && (!userId || String(p?.id) === String(userId)))
    .map(({ r, p }) => ({ id: r.id, contact: chatTitle(r.contact_name, r.phone), session: r.session_name, assignedTo: r.assigned_to || "", received: r.received, replied: r.replied, repliedBy: p?.name || null, lastAt: new Date(Number(r.last_at) * 1000).toISOString() }));
}

const minutesText = (s) => (s === null ? "no reply times yet" : s < 90 ? `${s} seconds` : s < 5400 ? `${Math.round(s / 60)} minutes` : `${(s / 3600).toFixed(1)} hours`);
export const summaryLine = (d) =>
  `${d.received} customer message${d.received === 1 ? "" : "s"} in, ${d.replied} repl${d.replied === 1 ? "y" : "ies"} out, ${d.newChats} new chat${d.newChats === 1 ? "" : "s"}. ` +
  `Median reply: ${minutesText(d.medianSeconds)}${d.withinSlaPercent !== null ? `, ${d.withinSlaPercent}% within target` : ""}. ` +
  `${d.waitingNow} chat${d.waitingNow === 1 ? "" : "s"} waiting for a reply${d.topAgent ? `. Most answered: ${d.topAgent.name} (${d.topAgent.answered})` : ""}.`;

// Each morning (after 05:00 UTC) the owners and administrators of every company that was active yesterday are told
// how it went: in the app, and by email where the company turned that on. Once per company per day.
export async function sendDailyReports(io, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = isoOfEpoch(Math.floor(now / 1000) - DAY);
  if (new Date(now).getUTCHours() < 5) return 0;
  const { rows } = await query(
    `SELECT t.id,t.name,COALESCE(rs.daily_in_app,true) AS in_app,COALESCE(rs.daily_email,false) AS email
     FROM tenants t LEFT JOIN report_settings rs ON rs.tenant_id=t.id
     WHERE t.status='active' AND rs.last_daily_for IS DISTINCT FROM $1::date AND (COALESCE(rs.daily_in_app,true) OR COALESCE(rs.daily_email,false))
       AND EXISTS (SELECT 1 FROM conversations c WHERE c.tenant_id=t.id AND c.updated_at > now() - interval '3 days')
     LIMIT 50`,
    [yesterday],
  );
  let sent = 0;
  for (const t of rows) {
    const claimed = await query(
      `INSERT INTO report_settings(tenant_id,last_daily_for) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET last_daily_for=$2
       WHERE report_settings.last_daily_for IS DISTINCT FROM $2::date RETURNING tenant_id`,
      [t.id, yesterday],
    );
    if (!claimed.rowCount) continue;
    try {
      const d = await dailySummary(t.id, yesterday, now);
      if (!d.received && !d.replied) continue; // a quiet day is not worth a message
      const managers = (await query(`SELECT u.id,u.email,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND m.role IN ('owner','admin')`, [t.id])).rows;
      const line = summaryLine(d);
      if (t.in_app)
        await createNotifications({ io, tenantId: t.id, recipients: managers.map((m) => ({ userId: m.id, type: "report" })), actor: null, dedupeKey: `report:${yesterday}`, title: `Yesterday in ${t.name}`, body: line });
      if (t.email)
        for (const m of managers.filter((x) => x.role === "owner"))
          await sendEmail({ to: m.email, subject: `Scriwo daily report for ${t.name}: ${yesterday}`, text: `Hello ${m.name},\n\n${line}\n\nOpen Reports in Scriwo for the numbers by team, person and WhatsApp number.\n` }).catch(() => {});
      sent++;
    } catch (e) {
      // try again on the next pass
      await query("UPDATE report_settings SET last_daily_for=NULL WHERE tenant_id=$1", [t.id]);
      console.error("Daily report failed:", t.id, e.message);
    }
  }
  return sent;
}
let lastRun = 0;
export async function pumpReports(io, { force = false } = {}) {
  if (!force && Date.now() - lastRun < 10 * 60 * 1000) return;
  lastRun = Date.now();
  await sendDailyReports(io);
}
