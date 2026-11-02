import { query } from "../db/index.js";
import { setSolution } from "../solutions/entitlements.js";
import { ensurePipeline } from "./leadService.js";

// A vertical is Scriwo sold to one industry under its own address, such as homes.scriwo.com for property agencies. The same
// product and the same code: what differs is the name people see, the industry layer switched on, the pipeline's steps and a
// 14-day trial of the Growth plan, so an agency sees the whole thing working before it decides. Nothing here is a second app.
//
// The trial uses the renewal-date rule that already exists: the company is put on Growth with a period that ends in 14 days,
// and seven days after that, as for any company that has not paid, its paid features switch off and it has what Free has.
// Nothing is deleted.

export const TRIAL_DAYS = 14;

export const VERTICALS = {
  homes: {
    key: "homes",
    name: "Scriwo Homes",
    tagline: "Every property enquiry captured, assigned, followed up and tracked.",
    intro: "The WhatsApp revenue system for property agencies in Dubai and the UAE.",
    solution: "real_estate",
    pipelinePreset: "real_estate",
    trialPlan: "Growth",
    trialNumbers: 3,
  },
};

export const verticalKey = (value) => (typeof value === "string" && Object.hasOwn(VERTICALS, value.toLowerCase()) ? value.toLowerCase() : null);

// "homes.scriwo.com" and "homes.localhost" belong to the homes vertical; anything else belongs to none.
export function verticalOfHost(host) {
  const first = String(host || "").toLowerCase().split(":")[0].split(".")[0];
  return verticalKey(first);
}

export const brandingOf = (key) => {
  const v = verticalKey(key) && VERTICALS[verticalKey(key)];
  return v ? { vertical: v.key, name: v.name, tagline: v.tagline, intro: v.intro, trialDays: TRIAL_DAYS } : { vertical: null, name: "Scriwo", tagline: "", intro: "", trialDays: 0 };
};

// Sets a company that has just signed up on a vertical's address up as that vertical: the trial, the industry layer, and the
// pipeline's steps. Safe to run twice. A failure is logged and never stops the signup: the company still has a working workspace.
export async function applyVertical({ tenantId, user, key, io = null }) {
  const v = verticalKey(key) && VERTICALS[verticalKey(key)];
  if (!v) return false;
  try {
    // only a company that is on Free (a new one) is given the trial; one that is already paying is left alone
    await query(
      `UPDATE tenants SET plan=$2, sessions_limit=$3, period_start=CURRENT_DATE, period_end=CURRENT_DATE + $4::int
        WHERE id=$1 AND plan='Free'`,
      [tenantId, v.trialPlan, v.trialNumbers, TRIAL_DAYS],
    );
    await ensurePipeline(tenantId, v.pipelinePreset);
    await setSolution({ tenantId, key: v.solution, enabled: true, actor: user ? { id: user.id, name: user.name } : null, io });
    await query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'vertical.applied',$3)", [tenantId, user?.id ?? null, JSON.stringify({ vertical: v.key, trialDays: TRIAL_DAYS })]);
    return true;
  } catch (error) {
    console.error(`Could not set up the ${v.name} workspace:`, error.message);
    return false;
  }
}
