import { query, withTransaction } from "../db/index.js";
import { fail } from "../middleware/http.js";
import { planAllows, notIncluded } from "../services/plans.js";
import { tell } from "../services/subscriptionService.js";
import { SOLUTIONS, isSolution, mergeSettings } from "./registry.js";

// Which industry solutions a company has. A company with no row has none: the universal product is the default.

const view = (key, row) => ({
  key,
  name: SOLUTIONS[key].name,
  version: row?.version ?? SOLUTIONS[key].version,
  summary: SOLUTIONS[key].summary,
  requires: SOLUTIONS[key].requires,
  enabled: Boolean(row?.enabled),
});

// What the browser is told in the capabilities: only the solutions that are switched on.
export async function activeSolutions(tenantId) {
  const { rows } = await query("SELECT solution_key,version FROM tenant_solutions WHERE tenant_id=$1 AND enabled ORDER BY solution_key", [tenantId]);
  return rows.filter((r) => isSolution(r.solution_key)).map((r) => ({ key: r.solution_key, name: SOLUTIONS[r.solution_key].name, version: r.version }));
}

// Everything the platform admin can give a company, with what it has now.
export async function solutionsFor(tenantId) {
  const { rows } = await query("SELECT * FROM tenant_solutions WHERE tenant_id=$1", [tenantId]);
  const byKey = Object.fromEntries(rows.map((r) => [r.solution_key, r]));
  return Object.keys(SOLUTIONS).map((key) => view(key, byKey[key]));
}

// For the platform's company list: which companies have what, in one query.
export async function solutionKeysByTenant() {
  const { rows } = await query("SELECT tenant_id,solution_key FROM tenant_solutions WHERE enabled ORDER BY solution_key");
  const out = {};
  for (const r of rows) if (isSolution(r.solution_key)) (out[r.tenant_id] ||= []).push(r.solution_key);
  return out;
}

export async function isEnabled(tenantId, key) {
  const { rows } = await query("SELECT 1 FROM tenant_solutions WHERE tenant_id=$1 AND solution_key=$2 AND enabled", [tenantId, key]);
  return rows.length > 0;
}

// The company's settings for a solution, with defaults filled in. Works whether or not the solution is switched on.
export async function settingsOf(tenantId, key) {
  if (!isSolution(key)) throw fail(404, "Unknown solution");
  const { rows } = await query("SELECT settings FROM tenant_solutions WHERE tenant_id=$1 AND solution_key=$2", [tenantId, key]);
  return mergeSettings(key, rows[0]?.settings || {});
}

export async function saveSettings(tenantId, key, patch) {
  if (!isSolution(key)) throw fail(404, "Unknown solution");
  const { rows } = await query("SELECT settings FROM tenant_solutions WHERE tenant_id=$1 AND solution_key=$2 AND enabled", [tenantId, key]);
  if (!rows[0]) throw fail(403, `${SOLUTIONS[key].name} isn't switched on for this company.`);
  const next = mergeSettings(key, rows[0].settings || {}, patch);
  await query("UPDATE tenant_solutions SET settings=$3,updated_at=now() WHERE tenant_id=$1 AND solution_key=$2", [tenantId, key, JSON.stringify(next)]);
  return next;
}

// The platform admin switches a solution on or off for one company. The company's managers are told, their open browsers
// look again at what they have, and the change is written to the audit log. Switching off deletes nothing.
export async function setSolution({ tenantId, key, enabled, actor, io = null }) {
  if (!isSolution(key)) throw fail(400, `Choose a solution: ${Object.keys(SOLUTIONS).join(", ")}`);
  if (typeof enabled !== "boolean") throw fail(400, "enabled must be true or false");
  const tenant = (await query("SELECT id,name,status FROM tenants WHERE id=$1", [tenantId])).rows[0];
  if (!tenant) throw fail(404, "Company not found");
  const solution = SOLUTIONS[key];
  const changed = await withTransaction(async (c) => {
    const before = (await c.query("SELECT enabled FROM tenant_solutions WHERE tenant_id=$1 AND solution_key=$2 FOR UPDATE", [tenantId, key])).rows[0];
    if ((before?.enabled ?? false) === enabled) return false;
    await c.query(
      `INSERT INTO tenant_solutions(tenant_id,solution_key,enabled,version,enabled_by) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id,solution_key) DO UPDATE SET enabled=$3,version=$4,enabled_by=$5,enabled_at=now(),updated_at=now()`,
      [tenantId, key, enabled, solution.version, actor?.id ?? null],
    );
    await c.query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,$3,$4)", [
      tenantId,
      actor?.id ?? null,
      enabled ? "solution.enabled" : "solution.disabled",
      JSON.stringify({ solution: key, version: solution.version }),
    ]);
    return true;
  });
  if (changed) {
    const title = enabled ? `${solution.name} is now switched on for your company` : `${solution.name} was switched off for your company`;
    const body = enabled ? "You will find it in the sidebar. Everything else in Scriwo works as before." : "It is hidden now. Nothing was deleted: it comes back as it was when it is switched on again.";
    await tell(io, tenantId, `solution:${key}:${enabled ? "on" : "off"}:${Date.now()}`, title, body).catch((e) => console.error("Solution notice failed:", e.message));
    // every open browser of the company looks again at what it has
    io?.to(`tenant:${tenantId}`).emit("plan:changed", { solution: key, enabled });
  }
  return { changed, solution: view(key, { enabled, version: solution.version }) };
}

// Route guard for a solution's API. The company must have been given the solution, and its plan must include what the
// solution is built on (so a company that has lapsed to Free loses the lead-based screens, exactly as it loses the pipeline).
export const requireSolution = (fixedKey) => async (req, res, next) => {
  try {
    const key = fixedKey || req.params.key;
    if (req.apiKey) throw fail(403, "Interactive workspace login required");
    if (!isSolution(key)) throw fail(404, "Unknown solution");
    if (!(await isEnabled(req.tenantId, key))) throw fail(403, `${SOLUTIONS[key].name} isn't switched on for your company. Ask the Scriwo team to switch it on.`);
    for (const feature of SOLUTIONS[key].requires) if (!planAllows(req.tenant, feature)) throw notIncluded(req.tenant, feature);
    next();
  } catch (error) {
    next(error);
  }
};

