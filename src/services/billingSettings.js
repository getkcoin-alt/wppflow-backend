import { query, withTransaction } from "../db/index.js";
import { fail } from "../middleware/http.js";
import { SELLER, sacCode, GST_RATE, prorateUpgrades } from "../config/billing.js";
import { STATES, validGstin } from "./gst.js";

// Who sells and how tax is worked out: the platform admin edits these and invoices pick them up straight away. The
// built-in values (the GST certificate, the service code from the environment, 18%) are what applies until someone
// saves a change, so nothing differs on the day this is deployed.
const DEFAULTS = () => ({
  seller: { ...SELLER, addressLines: [...SELLER.addressLines] },
  sacCode: sacCode(),
  gstRate: GST_RATE,
  invoicePrefix: "SCZ",
  prorateUpgrades: prorateUpgrades(),
});
let current = DEFAULTS();
export const billingSettings = () => current;

const merge = (base, saved = {}) => ({
  ...base,
  ...Object.fromEntries(Object.entries(saved).filter(([k]) => k in base && k !== "seller")),
  seller: { ...base.seller, ...(saved.seller || {}) },
});

export async function loadBillingSettings() {
  const row = (await query("SELECT value FROM billing_settings WHERE id=1")).rows[0];
  current = merge(DEFAULTS(), row?.value);
}
let refresher;
export function keepBillingSettingsFresh(everyMs = 60000) {
  clearInterval(refresher);
  refresher = setInterval(() => loadBillingSettings().catch((e) => console.error("Billing settings refresh:", e.message)), everyMs);
  refresher.unref?.();
}

// Invoice numbers may be at most 16 characters of letters, digits, "/" and "-" (CGST Rule 46): PREFIX/26-27/00001.
export const invoiceNumber = (prefix, series, seq) => `${prefix}/${series}/${String(seq).padStart(5, "0")}`;
export const financialYearSeries = (dateIso) => {
  const [y, m] = dateIso.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
};

const text = (v, label, max, { required = true } = {}) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s && required) throw fail(400, `${label} is required`);
  if (s.length > max) throw fail(400, `${label} can be up to ${max} characters`);
  return s;
};

// Checks a change before anything is saved. Fields that are not mentioned stay as they are.
export function cleanSettings(patch, base = current) {
  const next = merge(base, {});
  if (patch.sacCode !== undefined) {
    const sac = String(patch.sacCode).trim();
    if (!/^99\d{4}$/.test(sac)) throw fail(400, "A service accounting code (SAC) is six digits and starts with 99, for example 998314");
    next.sacCode = sac;
  }
  if (patch.gstRate !== undefined) {
    const rate = Number(patch.gstRate);
    if (!Number.isInteger(rate) || rate < 0 || rate > 28) throw fail(400, "The GST rate must be a whole number from 0 to 28");
    next.gstRate = rate;
  }
  if (patch.invoicePrefix !== undefined) {
    const prefix = String(patch.invoicePrefix).trim().toUpperCase();
    // PREFIX/26-27/00001 must stay within the 16 characters the invoice number is allowed
    if (!/^[A-Z0-9]{1,3}$/.test(prefix)) throw fail(400, "The invoice prefix is one to three letters or digits, for example SCZ. An invoice number can be at most 16 characters long.");
    next.invoicePrefix = prefix;
  }
  if (patch.prorateUpgrades !== undefined) {
    if (typeof patch.prorateUpgrades !== "boolean") throw fail(400, "Say whether an upgrade credits the unused days");
    next.prorateUpgrades = patch.prorateUpgrades;
  }
  if (patch.seller !== undefined) {
    const s = patch.seller || {};
    const seller = { ...next.seller };
    if (s.legalName !== undefined) seller.legalName = text(s.legalName, "Legal name", 120);
    if (s.tradeName !== undefined) seller.tradeName = text(s.tradeName, "Trade name", 60, { required: false });
    if (s.gstin !== undefined) {
      const gstin = String(s.gstin).trim().toUpperCase();
      if (!validGstin(gstin)) throw fail(400, "That GSTIN is not valid. It has 15 characters and ends with a check character; copy it from the registration certificate.");
      seller.gstin = gstin;
    }
    if (s.addressLines !== undefined) {
      if (!Array.isArray(s.addressLines)) throw fail(400, "The address is a list of lines");
      const lines = s.addressLines.map((l) => text(l, "An address line", 120, { required: false })).filter(Boolean);
      if (!lines.length || lines.length > 3) throw fail(400, "Give the address in one to three lines");
      seller.addressLines = lines;
    }
    if (s.city !== undefined) seller.city = text(s.city, "City", 80);
    if (s.postalCode !== undefined) {
      const code = String(s.postalCode).trim();
      if (!/^\d{6}$/.test(code)) throw fail(400, "The PIN code is six digits");
      seller.postalCode = code;
    }
    if (s.email !== undefined) {
      const email = text(s.email, "Billing email", 120);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, "That billing email is not valid");
      seller.email = email;
    }
    // the state is the one printed on the GSTIN: it decides CGST + SGST or IGST, so it is never typed separately
    seller.stateCode = seller.gstin.slice(0, 2);
    seller.state = STATES[seller.stateCode];
    next.seller = seller;
  }
  return next;
}

export async function saveBillingSettings(patch, actorId) {
  const before = current;
  const next = cleanSettings(patch || {}, before);
  if (JSON.stringify(before) === JSON.stringify(next)) return view();
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO billing_settings(id,value,updated_by) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [JSON.stringify(next), actorId ?? null],
    );
    await client.query("INSERT INTO billing_settings_changes(actor_id,before,after) VALUES($1,$2,$3)", [actorId ?? null, JSON.stringify(before), JSON.stringify(next)]);
  });
  current = next;
  return view();
}

const FIELDS = { sacCode: "Service code (SAC)", gstRate: "GST rate", invoicePrefix: "Invoice prefix", prorateUpgrades: "Credit unused days on an upgrade" };
const SELLER_FIELDS = { legalName: "Legal name", tradeName: "Trade name", gstin: "GSTIN", city: "City", postalCode: "PIN code", email: "Billing email", addressLines: "Address" };
const show = (v) => (Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "yes" : "no") : String(v ?? ""));

// What changed between two versions of the settings, in words.
export function describeChange(before, after) {
  const out = [];
  for (const [k, label] of Object.entries(FIELDS)) if (show(before[k]) !== show(after[k])) out.push({ field: label, from: show(before[k]), to: show(after[k]) });
  for (const [k, label] of Object.entries(SELLER_FIELDS)) if (show(before.seller?.[k]) !== show(after.seller?.[k])) out.push({ field: label, from: show(before.seller?.[k]), to: show(after.seller?.[k]) });
  return out;
}

export async function settingsHistory(limit = 50) {
  const { rows } = await query(
    `SELECT c.id,c.before,c.after,c.created_at,u.name AS actor FROM billing_settings_changes c LEFT JOIN users u ON u.id=c.actor_id ORDER BY c.id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ id: r.id, actor: r.actor, at: r.created_at, changes: describeChange(r.before, r.after) }));
}

export function view(now = new Date()) {
  const s = current;
  const series = financialYearSeries(new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10));
  return { ...s, seller: { ...s.seller }, nextInvoiceExample: invoiceNumber(s.invoicePrefix, series, 1), invoiceNumberLimit: 16 };
}
