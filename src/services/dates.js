// Calendar days, as "2026-11-25" strings in UTC. A DATE column comes back from the database as a Date at local
// midnight, so it is read with the local parts to give the same day back.
const pad = (n) => String(n).padStart(2, "0");
const DAY = 24 * 3600 * 1000;
export const todayUtc = () => new Date().toISOString().slice(0, 10);
export const utcDate = (date) => new Date(`${date}T00:00:00Z`);
export const daysBetween = (from, to) => Math.round((utcDate(to) - utcDate(from)) / DAY);
export const dateOnly = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
};
