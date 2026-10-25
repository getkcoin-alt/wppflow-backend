import { query } from "../db/index.js";
import { failWith } from "../middleware/http.js";
import { entitledPlan } from "./plans.js";

// What a company's plan allows and what it has used. The numbers are counted from the data every time, so they
// cannot drift from it. A limit stops people on the team adding more; it never stops a customer's message arriving
// and never deletes anything.
export const NEAR = 0.8;

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export const monthName = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" });
export const limitsOf = (tenant) => {
  const plan = entitledPlan(tenant);
  return { plan: plan.name, contacts: plan.maxContacts ?? null, broadcasts: plan.maxBroadcasts ?? null };
};
export const stateOf = (used, limit) => (limit === null ? "unlimited" : used >= limit ? "full" : used >= Math.ceil(limit * NEAR) ? "near" : "ok");

const tenantOf = async (tenantId, db = query) => (await db("SELECT plan,period_end,scheduled_plan FROM tenants WHERE id=$1", [tenantId])).rows[0];
const contactsOf = async (tenantId, db = query) => (await db("SELECT count(*)::int AS n FROM contacts WHERE tenant_id=$1", [tenantId])).rows[0].n;
const broadcastsOf = async (tenantId, now, db = query, except = null) =>
  (await db("SELECT count(*)::int AS n FROM campaigns WHERE tenant_id=$1 AND started_at >= $2 AND ($3::varchar IS NULL OR id<>$3)", [tenantId, monthStart(now), except])).rows[0].n;

export async function usageOf(tenantId, { tenant = null, now = new Date() } = {}) {
  const row = tenant || (await tenantOf(tenantId));
  const limits = limitsOf(row);
  const [contacts, broadcasts] = await Promise.all([contactsOf(tenantId), broadcastsOf(tenantId, now)]);
  return {
    plan: limits.plan,
    contacts: { used: contacts, limit: limits.contacts, state: stateOf(contacts, limits.contacts) },
    broadcasts: { used: broadcasts, limit: limits.broadcasts, state: stateOf(broadcasts, limits.broadcasts), resets: `1 ${monthName(now)}` },
  };
}

const contactsMessage = (plan, limit, used) =>
  `Your ${plan} plan includes up to ${limit.toLocaleString("en")} contacts and you have ${used.toLocaleString("en")}. Remove some contacts, or move to a bigger plan under Team → Plans & Billing.`;

// Before one person on the team adds contacts by hand. `db` can be a transaction's query function.
export async function assertRoomForContacts(tenantId, adding = 1, db = query) {
  const limit = limitsOf(await tenantOf(tenantId, db)).contacts;
  if (limit === null) return;
  const used = await contactsOf(tenantId, db);
  if (used + adding > limit) throw failWith(403, contactsMessage(limitsOf(await tenantOf(tenantId, db)).plan, limit, used), { code: "plan_limit", limit: "contacts", used, allowed: limit });
}

// How many more contacts a company can take: null when there is no limit.
export async function roomForContacts(tenantId, db = query) {
  const limit = limitsOf(await tenantOf(tenantId, db)).contacts;
  if (limit === null) return null;
  return Math.max(0, limit - (await contactsOf(tenantId, db)));
}

// After a file of contacts was added in one go: if it pushed the company over, the whole batch is refused. A file
// that only updated people already there is never refused, even if the company is over because customers wrote in.
export async function assertImportFits(tenantId, before, db) {
  const limit = limitsOf(await tenantOf(tenantId, db)).contacts;
  if (limit === null) return;
  const after = await contactsOf(tenantId, db);
  if (after > limit && after > before) {
    const plan = limitsOf(await tenantOf(tenantId, db)).plan;
    throw failWith(403, `${contactsMessage(plan, limit, before)} This file would add ${(after - before).toLocaleString("en")} more, so none of this batch was saved.`, { code: "plan_limit", limit: "contacts", used: before, allowed: limit });
  }
}
export const contactCount = contactsOf;

// Starting a broadcast. One that was already started this month (a pause and a restart) is not counted again.
export async function assertRoomForBroadcast(tenantId, campaign, db = query, now = new Date()) {
  const limits = limitsOf(await tenantOf(tenantId, db));
  if (limits.broadcasts === null) return;
  if (campaign?.started_at && new Date(campaign.started_at) >= monthStart(now)) return;
  const used = await broadcastsOf(tenantId, now, db, campaign?.id ?? null);
  if (used >= limits.broadcasts)
    throw failWith(
      403,
      `Your ${limits.plan} plan includes ${limits.broadcasts} broadcast${limits.broadcasts === 1 ? "" : "s"} a month and ${used} ${used === 1 ? "has" : "have"} already been started this month. The count starts again on 1 ${monthName(now)}, or you can move to a bigger plan under Team → Plans & Billing.`,
      { code: "plan_limit", limit: "broadcasts", used, allowed: limits.broadcasts },
    );
}
