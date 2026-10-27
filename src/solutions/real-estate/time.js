// Times for viewings. A viewing is booked in a place's local time ("4 pm in Dubai") and stored as an exact moment; these
// helpers convert in both directions using the zone database that ships with Node, so daylight-saving changes are right.
export const isZone = (zone) => {
  if (typeof zone !== "string" || !zone.trim() || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const formatter = (zone) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

// What the wall clock in `zone` shows at the moment `ms`.
export function localParts(ms, zone) {
  const p = Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}
const asUtcMs = (p) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
const offsetMs = (ms, zone) => asUtcMs(localParts(ms, zone)) - Math.floor(ms / 1000) * 1000;

// The moment when the wall clock in `zone` reads `date` (YYYY-MM-DD) and `time` (HH:MM). A time that does not exist
// (the hour skipped when clocks go forward) is refused. A time that happens twice (clocks go back) is the first one.
export function zonedToUtc({ date, time, zone }) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  const t = /^(\d{2}):(\d{2})$/.exec(String(time));
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [+d[1], +d[2], +d[3], +t[1], +t[2]];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, da, h, mi, 0);
  if (new Date(guess).getUTCMonth() !== mo - 1) return null; // 31 February and the like
  const candidates = new Set([guess - offsetMs(guess - 86400000, zone), guess - offsetMs(guess, zone), guess - offsetMs(guess + 86400000, zone)]);
  const hits = [...candidates].filter((ms) => {
    const p = localParts(ms, zone);
    return p.year === y && p.month === mo && p.day === da && p.hour === h && p.minute === mi;
  });
  return hits.length ? new Date(Math.min(...hits)) : null;
}

const pad = (n) => String(n).padStart(2, "0");
// "2026-11-03" and "16:00" as read on a wall clock in `zone`.
export function localDateTime(ms, zone) {
  const p = localParts(ms, zone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}
// "Tue 3 Nov 2026, 16:00" for people to read.
export function humanDateTime(ms, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
}
