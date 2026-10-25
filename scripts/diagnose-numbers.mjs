// Read-only report on the WhatsApp numbers of this server: memory, browsers, what the database
// believes, the saved logins on disk and the recent log lines about them. Nothing is changed.
// Usage, on the server:  cd /opt/wppflow-backend && node scripts/diagnose-numbers.mjs
// Phone numbers are shortened to their last four digits and long secrets are hidden, so the output
// can be pasted into a support chat.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENV } from "../src/config/env.js";
import { query, closePool } from "../src/db/index.js";

const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
const mask = (phone) => (phone ? `…${String(phone).replace(/\D/g, "").slice(-4)}` : "-");
const hide = (line) => line.replace(/[A-Za-z0-9_\-+/=]{40,}/g, "<hidden>").replace(/sk-[\w-]+/g, "<hidden>");
const heading = (text) => console.log(`\n== ${text}`);

heading("Machine");
console.log(`memory: ${mb(os.freemem())} free of ${mb(os.totalmem())}; cpus: ${os.cpus().length}; load: ${os.loadavg().map((n) => n.toFixed(2)).join(" ")}; uptime: ${Math.round(os.uptime() / 3600)} h`);

heading("Browsers (one per linked number is expected)");
const browsers = new Map();
try {
  for (const pid of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const profile = args.find((a) => a.startsWith("--user-data-dir="));
      if (!profile || args.some((a) => a.startsWith("--type="))) continue; // helper processes belong to the main one
      const rss = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
      browsers.set(path.basename(profile.slice("--user-data-dir=".length)), { pid, rss: rss ? Number(rss[1]) * 1024 : 0 });
    } catch {
      /* ended while we looked */
    }
  }
} catch {
  console.log("(cannot read /proc on this machine)");
}
for (const [name, b] of browsers) console.log(`${name}  pid ${b.pid}  main process ${mb(b.rss)}`);
console.log(`${browsers.size} browser(s) running`);

try {
  heading("Companies and their number limit");
  const tenants = await query(`SELECT t.name,t.plan,t.sessions_limit,t.status,count(s.id)::int AS numbers FROM tenants t LEFT JOIN whatsapp_sessions s ON s.tenant_id=t.id GROUP BY t.id ORDER BY t.name`);
  for (const t of tenants.rows) console.log(`${t.name}: plan ${t.plan}, ${t.numbers} of ${t.sessions_limit} numbers, ${t.status}`);

  heading("Numbers in the database");
  const sessions = await query(`SELECT t.name AS company,s.session_name,s.status,s.phone,s.restore_on_start,s.worker_id IS NOT NULL AS owned,
      round(extract(epoch FROM (s.lease_until-now()))) AS lease_s,s.last_error,s.updated_at,s.created_at
    FROM whatsapp_sessions s JOIN tenants t ON t.id=s.tenant_id ORDER BY t.name,s.created_at`);
  for (const s of sessions.rows)
    console.log(`${s.company} / ${s.session_name}: ${s.status}, phone ${mask(s.phone)}, restore ${s.restore_on_start}, running here ${s.owned}, lease ${s.lease_s ?? "-"} s, updated ${new Date(s.updated_at).toISOString()}${s.last_error ? `, error: ${hide(s.last_error)}` : ""}`);

  heading("Saved logins on disk");
  const root = path.resolve(ENV.TOKEN_DIR);
  const known = new Set((await query("SELECT tenant_id,session_name FROM whatsapp_sessions")).rows.map((s) => `tenant_${s.tenant_id}_${s.session_name}`));
  console.log(`folder: ${root}`);
  for (const name of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const inside = fs.readdirSync(dir);
    console.log(`${name}: ${known.has(name) ? "has a number" : "NO NUMBER USES THIS"}; ${inside.length} item(s); changed ${fs.statSync(dir).mtime.toISOString()}`);
  }
} finally {
  await closePool();
}

heading("Recent log lines about numbers");
const logs = path.join(os.homedir(), ".pm2", "logs");
const lines = [];
for (const file of fs.existsSync(logs) ? fs.readdirSync(logs).filter((f) => /^wppflow.*(out|error)\.log$/.test(f)) : []) {
  const text = fs.readFileSync(path.join(logs, file), "utf8").split("\n").slice(-4000);
  lines.push(...text.filter((l) => /WhatsApp |Session |session|browser|Chrom|QR|memory|killed|Using browser folder/i.test(l)).map(hide));
}
console.log(lines.slice(-70).join("\n") || "(none found in ~/.pm2/logs)");
