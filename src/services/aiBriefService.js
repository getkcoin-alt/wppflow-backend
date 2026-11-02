import { query } from "../db/index.js";
import { dailySummary, summaryLine } from "./reportService.js";
import { unavailableReason, usageOf, writeBrief } from "./aiService.js";

// The morning brief for owners and administrators: how yesterday went and what to look at today. The facts always come
// from the saved numbers; Riwo only words them, when it can. With no Riwo the plain summary line is the brief, so the
// owner gets one either way. Once per company per day, written after 04:00 UTC, for companies that had any activity.

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoYesterday = (ms) => dayOf(ms - 86_400_000);
let lastRun = 0;

export async function writeFor(tenant, now = Date.now()) {
  const day = dayOf(now);
  const facts = await dailySummary(tenant.id, isoYesterday(now), now);
  const base = summaryLine(facts);
  const quiet = facts.received === 0 && facts.replied === 0 && facts.waitingNow === 0;
  if (quiet) return null;
  let text = base;
  let source = "rules";
  if (unavailableReason(tenant) === null) {
    const usage = await usageOf(tenant);
    if (usage.used < usage.limit * 0.9) {
      try {
        const out = await writeBrief({ tenant, facts: `${base}\nWaiting for a reply right now: ${facts.waitingNow}.` });
        if (out.text) (text = out.text), (source = "ai");
      } catch {
        /* the plain line is the brief */
      }
    }
  }
  const { rowCount } = await query("INSERT INTO ai_briefs(tenant_id,day,text,source) VALUES($1,$2,$3,$4) ON CONFLICT (tenant_id,day) DO NOTHING", [tenant.id, day, text, source]);
  return rowCount ? { day, text, source } : null;
}

export async function pumpAiBrief(io, { force = false, now = Date.now() } = {}) {
  if (!force && now - lastRun < 10 * 60_000) return 0;
  lastRun = now;
  if (new Date(now).getUTCHours() < 4) return 0;
  const tenants = (
    await query(
      `SELECT t.* FROM tenants t WHERE t.status='active'
         AND NOT EXISTS (SELECT 1 FROM ai_briefs b WHERE b.tenant_id=t.id AND b.day=$1::date)
         AND EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id=t.id AND m.timestamp_epoch > $2) LIMIT 30`,
      [dayOf(now), Math.floor(now / 1000) - 3 * 86400],
    )
  ).rows;
  let written = 0;
  for (const tenant of tenants) {
    try {
      if (await writeFor(tenant, now)) written += 1;
    } catch (error) {
      console.error("Morning brief failed:", tenant.id, error.message);
    }
  }
  return written;
}

// The newest brief from the last two days, so the morning's brief stays until the next one.
export async function latestBrief(tenantId, now = Date.now()) {
  const r = (await query("SELECT day,text,source FROM ai_briefs WHERE tenant_id=$1 AND day >= $2::date ORDER BY day DESC LIMIT 1", [tenantId, isoYesterday(now)])).rows[0];
  return r ? { day: String(r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day).slice(0, 10), text: r.text, source: r.source } : null;
}
