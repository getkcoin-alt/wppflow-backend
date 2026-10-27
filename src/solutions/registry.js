import { fail } from "../middleware/http.js";
import { manifest as realEstate } from "./real-estate/manifest.js";

// The industry solutions this server knows about. Adding one means writing its folder under src/solutions and listing its
// manifest here: there is no discovery and no plugin loader, so nothing runs that is not named in this file.
export const SOLUTIONS = Object.fromEntries([realEstate].map((m) => [m.key, m]));

export const solutionKeys = () => Object.keys(SOLUTIONS);
export const isSolution = (key) => typeof key === "string" && Object.hasOwn(SOLUTIONS, key);
export const solutionOf = (key) => (isSolution(key) ? SOLUTIONS[key] : null);

export const defaultSettings = (key) => Object.fromEntries(Object.entries(SOLUTIONS[key].settings).map(([k, s]) => [k, s.default]));

// Applies a change to a company's settings. Unknown settings are refused, every value is checked, and the result is
// always a complete set (defaults fill what the company has not chosen).
export function mergeSettings(key, current = {}, patch = {}) {
  const defs = SOLUTIONS[key].settings;
  const next = { ...defaultSettings(key) };
  for (const k of Object.keys(next)) if (current[k] !== undefined && defs[k]) {
    try {
      next[k] = defs[k].check(current[k]);
    } catch {
      /* a stored value that no longer passes falls back to the default */
    }
  }
  for (const [k, v] of Object.entries(patch || {})) {
    if (!defs[k]) throw fail(400, `Unknown setting: ${k}`);
    next[k] = defs[k].check(v);
  }
  return next;
}
