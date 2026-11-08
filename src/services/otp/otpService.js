import crypto from "node:crypto";
import { query, withTransaction } from "../../db/index.js";
import { defaultWhatsAppProvider as provider } from "../whatsapp/WhatsAppProvider.js";
import { normalizePhone, PHONE_HELP } from "../phone.js";
import { sameNumber } from "../personGuard.js";
import { OTP, otpEnabled, allowanceOf, hmac, sameHex, visitorHashOf, dayStart, monthStart, nextDay, nextMonth } from "./config.js";
import { otpError } from "./keys.js";
import { TEMPLATES, TEMPLATE_KEYS, LOCALES, templateOf, renderOtp, cleanBrand, brandProblem, maskPhone } from "./templates.js";
import { expectEcho, noteOtpSent, textHash, hasRecentOtp } from "./guard.js";
import { emitOtpEvent } from "./events.js";

// A code that can still be checked
export const OPEN = ["pending", "sent", "delivered", "read", "uncertain"];
const isOpen = (status) => OPEN.includes(status);

const newId = () => `otp_${crypto.randomBytes(12).toString("hex")}`;
const codeOf = (length) => String(crypto.randomInt(0, 10 ** length)).padStart(length, "0");
// the code is never stored: only an HMAC of it, tied to its request, which is what a check is compared with
const hashCode = (id, code) => hmac("code", `${id}:${code}`);

// ── a company's settings ──────────────────────────────────────────────────────────────────────────────────────────────

export async function settingsOf(tenantId) {
  let { rows } = await query("SELECT * FROM otp_settings WHERE tenant_id=$1", [tenantId]);
  if (!rows[0]) {
    await query("INSERT INTO otp_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING", [tenantId]);
    ({ rows } = await query("SELECT * FROM otp_settings WHERE tenant_id=$1", [tenantId]));
  }
  const company = (await query("SELECT name FROM tenants WHERE id=$1", [tenantId])).rows[0]?.name || "";
  // the name in the message: the one typed in settings, else the company's own name
  return { ...rows[0], brandResolved: cleanBrand(rows[0].brand) || cleanBrand(company) };
}

export const settingsView = (s) => ({
  enabled: s.enabled,
  template: s.template_key,
  brand: s.brand,
  brandResolved: s.brandResolved,
  locale: s.locale,
  codeLength: s.code_length,
  ttlSeconds: s.ttl_seconds,
  maxAttempts: s.max_attempts,
  resendSeconds: s.resend_seconds,
  sessionName: s.session_name,
  suspended: Boolean(s.suspended_reason),
});

const whole = (value, name, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw otpError(400, "invalid_settings", `${name} must be a whole number from ${min} to ${max}.`, "Pick a value in that range.");
  return n;
};

// What a person changes in the studio. Choosing a use case sets its usual digits, expiry, tries and resend wait in one go, unless
// the same change also says otherwise.
export async function updateSettings(tenantId, patch = {}) {
  const current = await settingsOf(tenantId);
  const next = {};
  if (patch.template !== undefined) {
    const t = templateOf(patch.template);
    if (!t) throw otpError(400, "invalid_settings", "That use case does not exist.", `Choose one of: ${TEMPLATE_KEYS.join(", ")}.`);
    next.template_key = t.key;
    if (t.key !== current.template_key) {
      next.code_length = t.defaults.codeLength;
      next.ttl_seconds = t.defaults.ttlSeconds;
      next.max_attempts = t.defaults.maxAttempts;
      next.resend_seconds = t.defaults.resendSeconds;
    }
  }
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.brand !== undefined) {
    const brand = String(patch.brand ?? "").trim();
    if (brand) {
      const problem = brandProblem(brand);
      if (problem) throw otpError(400, "invalid_brand", problem, "For example: Acme Stores");
    }
    next.brand = brand;
  }
  if (patch.locale !== undefined) {
    if (!LOCALES.includes(patch.locale)) throw otpError(400, "invalid_settings", "That language is not available.", `Choose one of: ${LOCALES.join(", ")}.`);
    next.locale = patch.locale;
  }
  if (patch.codeLength !== undefined) next.code_length = whole(patch.codeLength, "The code length", 4, 8);
  if (patch.ttlSeconds !== undefined) next.ttl_seconds = whole(patch.ttlSeconds, "The time before a code expires", 60, 3600);
  if (patch.maxAttempts !== undefined) next.max_attempts = whole(patch.maxAttempts, "The number of tries", 1, 10);
  if (patch.resendSeconds !== undefined) next.resend_seconds = whole(patch.resendSeconds, "The wait before a resend", 15, 300);
  if (patch.sessionName !== undefined) {
    if (patch.sessionName === null || patch.sessionName === "") next.session_name = null;
    else {
      const found = await query("SELECT 1 FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2", [tenantId, String(patch.sessionName)]);
      if (!found.rowCount) throw otpError(400, "invalid_settings", "That WhatsApp number is not linked to this company.", "Pick one of the linked numbers, or link one first.");
      next.session_name = String(patch.sessionName);
    }
  }
  const columns = Object.keys(next);
  if (columns.length) {
    await query(
      `UPDATE otp_settings SET ${columns.map((c, i) => `${c}=$${i + 2}`).join(",")},updated_at=now() WHERE tenant_id=$1`,
      [tenantId, ...columns.map((c) => next[c])],
    );
  }
  return settingsOf(tenantId);
}

// What one request uses: the company's settings, with the use case and language the caller may name for this one code
function effective(settings, { template, locale } = {}) {
  const t = template === undefined || template === null || template === "" ? settings.template_key : template;
  if (!templateOf(t)) throw otpError(400, "invalid_template", "That use case does not exist.", `Use one of: ${TEMPLATE_KEYS.join(", ")}.`);
  const l = locale === undefined || locale === null || locale === "" ? settings.locale : locale;
  if (!LOCALES.includes(l)) throw otpError(400, "invalid_locale", "That language is not available.", `Use one of: ${LOCALES.join(", ")}.`);
  return { template: t, locale: l, codeLength: settings.code_length, ttlSeconds: settings.ttl_seconds, maxAttempts: settings.max_attempts, resendSeconds: settings.resend_seconds, brand: settings.brandResolved };
}

// ── what has been used ─────────────────────────────────────────────────────────────────────────────────────────────────

export async function usageOf(tenantId, settings = null, now = new Date()) {
  const s = settings || (await settingsOf(tenantId));
  const { rows } = await query(
    `SELECT count(*) FILTER (WHERE created_at >= $2) AS day, count(*) AS month FROM otp_requests WHERE tenant_id=$1 AND mode='live' AND status<>'failed' AND created_at >= $3`,
    [tenantId, dayStart(now), monthStart(now)],
  );
  const allowance = allowanceOf(s);
  return {
    today: { used: Number(rows[0].day), limit: allowance.perDay, resets: nextDay(now).toISOString() },
    month: { used: Number(rows[0].month), limit: allowance.perMonth, resets: nextMonth(now).toISOString() },
  };
}

// ── which WhatsApp number sends, and how fast ──────────────────────────────────────────────────────────────────────────

async function senderFor(tenantId, settings) {
  const { rows } = await query("SELECT session_name,status,phone FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY created_at,session_name", [tenantId]);
  const chosen = settings.session_name ? rows.find((r) => r.session_name === settings.session_name) : null;
  // a number that is linked but not connected is "offline", not "missing": the fix is different
  const pick = chosen || rows.find((r) => r.status === "CONNECTED") || rows[0];
  if (!pick) throw otpError(503, "no_number_connected", "No WhatsApp number is linked, so there is nothing to send the code from.", "Link a number under Developers, Free OTP (or Numbers), then try again.");
  if (pick.status !== "CONNECTED" || !provider.getSession(tenantId, pick.session_name)?.client)
    throw otpError(503, "number_offline", "The WhatsApp number that sends the codes is offline right now.", "Open Numbers in Scriwo and reconnect it, then try again.");
  return pick;
}

// at most perNumberPerMinute codes a minute from one number, so a burst cannot get it restricted
const paced = new Map();
function takeSlot(tenantId, sessionName, now = Date.now()) {
  const k = `${tenantId}|${sessionName}`;
  const list = (paced.get(k) || []).filter((t) => now - t < 60000);
  if (list.length >= OTP.perNumberPerMinute) {
    paced.set(k, list);
    return Math.max(1, Math.ceil((list[0] + 60000 - now) / 1000));
  }
  list.push(now);
  paced.set(k, list);
  return 0;
}

// is this number on WhatsApp? Remembered for a few minutes so a repeat does not ask again. null: could not tell, so go ahead.
const known = new Map();
async function onWhatsApp(tenantId, sessionName, phone) {
  const k = `${tenantId}|${phone}`;
  const hit = known.get(k);
  if (hit && Date.now() < hit.until) return hit;
  const res = await provider.checkNumber(tenantId, sessionName, phone);
  if (!res?.checked) return { exists: null, jid: null };
  const entry = { exists: res.exists, jid: res.jid || null, until: Date.now() + (res.exists ? 600000 : 120000) };
  if (known.size > 2000) known.clear();
  known.set(k, entry);
  return entry;
}

// ── views ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const seconds = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000)) : null);
export const requestView = (r) => ({
  id: r.id,
  status: r.status,
  mode: r.mode,
  source: r.source,
  to: maskPhone(r.phone),
  template: r.template_key,
  locale: r.locale,
  reference: r.reference,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  createdAt: r.created_at,
  sentAt: r.sent_at,
  deliveredAt: r.delivered_at,
  verifiedAt: r.verified_at,
  expiresAt: r.expires_at,
  error: r.error_code,
  secondsToVerify: seconds(r.sent_at, r.verified_at),
});
// ("status" is the envelope's: success or error. What became of the code is "state".)
const sendView = (r) => ({
  id: r.id,
  state: r.status,
  mode: r.mode,
  channel: "whatsapp",
  to: maskPhone(r.phone),
  expiresIn: Math.max(0, Math.round((new Date(r.expires_at) - Date.now()) / 1000)),
  resendAfter: r.resend_seconds ?? undefined,
});

// ── send ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const cleanReference = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") throw otpError(400, "invalid_reference", "The reference must be text.", "Send something like your user id or order number.");
  return String(value).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) || null;
};
const cleanIdempotency = (value) => {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (v.length > 100) throw otpError(400, "invalid_idempotency_key", "The Idempotency-Key is too long (up to 100 characters).", "Use a short unique id.");
  return v;
};
const retryIn = (date, now = Date.now()) => Math.max(1, Math.ceil((date - now) / 1000));

export async function sendOtp({ tenantId, key = null, source = "api", phone: rawPhone, reference, locale, template, idempotencyKey, visitor = "" }) {
  if (!otpEnabled()) throw otpError(503, "otp_unavailable", "OTP is switched off on the platform for now.", "Try again in a little while.");
  const mode = key?.mode || "live";
  const settings = await settingsOf(tenantId);
  if (settings.suspended_reason) throw otpError(403, "otp_suspended", "OTP has been suspended for this company.", "Write to the Scriwo team to have it switched back on.");
  if (!settings.enabled && mode === "live" && source !== "dashboard") throw otpError(403, "otp_paused", "OTP is switched off for this company.", "Switch it on under Developers, Free OTP.");

  const phone = normalizePhone(rawPhone);
  if (!phone) throw otpError(400, "invalid_phone", "That is not a full international phone number.", PHONE_HELP);
  const ref = cleanReference(reference);
  const idem = cleanIdempotency(idempotencyKey);
  if (idem) {
    const prior = (await query("SELECT * FROM otp_requests WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, idem])).rows[0];
    if (prior) return { ...sendView({ ...prior, resend_seconds: settings.resend_seconds }), idempotent: true, httpStatus: prior.status === "uncertain" ? 202 : 200 };
  }
  const cfg = effective(settings, { template, locale });
  const id = newId();
  const visitorHash = visitorHashOf(visitor);

  // a test key sends nothing and always uses the same code, so a developer can build without a phone or using any allowance
  if (mode === "test") {
    const { rows } = await query(
      `INSERT INTO otp_requests(id,tenant_id,key_id,source,mode,phone,template_key,locale,status,code_hash,max_attempts,reference,idempotency_key,visitor_hash,sent_at,expires_at)
       VALUES($1,$2,$3,$4,'test',$5,$6,$7,'sent',$8,$9,$10,$11,$12,now(),now()+make_interval(secs=>$13)) RETURNING *`,
      [id, tenantId, key?.id ?? null, source, phone, cfg.template, cfg.locale, hashCode(id, OTP.testCode), cfg.maxAttempts, ref, idem, visitorHash, cfg.ttlSeconds],
    );
    await emitOtpEvent(tenantId, "otp.sent", rows[0]);
    return { ...sendView({ ...rows[0], resend_seconds: cfg.resendSeconds }), test: true, code: OTP.testCode, httpStatus: 201 };
  }

  const sender = await senderFor(tenantId, settings);
  if (sameNumber(sender.phone, phone)) throw otpError(400, "same_number", "That is the number the codes are sent from.", "Send to a different WhatsApp number. A number cannot receive its own code.");

  const code = codeOf(cfg.codeLength);
  const text = renderOtp({ template: cfg.template, locale: cfg.locale, brand: cfg.brand, code, ttlSeconds: cfg.ttlSeconds });
  const allowance = allowanceOf(settings);

  // the limits are counted and the request recorded in one step, so two calls at once cannot both slip under a limit
  let row;
  try {
    row = await withTransaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`otp:${tenantId}`]);
      const now = new Date();
      const n = (
        await c.query(
          `SELECT
             count(*) FILTER (WHERE status<>'failed' AND created_at >= $2) AS day,
             count(*) FILTER (WHERE status<>'failed') AS month,
             count(*) FILTER (WHERE phone=$4 AND created_at >= now() - make_interval(secs=>$5)) AS phone_window,
             count(*) FILTER (WHERE phone=$4 AND created_at >= $2) AS phone_day,
             max(created_at) FILTER (WHERE phone=$4 AND status IN ('pending','sent','delivered','read','uncertain')) AS last_open
           FROM otp_requests WHERE tenant_id=$1 AND mode='live' AND created_at >= $3`,
          [tenantId, dayStart(now), monthStart(now), phone, OTP.perPhoneWindowSeconds],
        )
      ).rows[0];
      if (n.last_open && new Date(n.last_open).getTime() + cfg.resendSeconds * 1000 > now.getTime()) {
        const after = retryIn(new Date(n.last_open).getTime() + cfg.resendSeconds * 1000, now.getTime());
        throw otpError(429, "resend_too_soon", "A code was sent to this number a moment ago.", `Ask the person to wait ${after} seconds before asking again.`, { retryAfter: after });
      }
      if (Number(n.phone_window) >= OTP.perPhoneWindow) {
        const after = OTP.perPhoneWindowSeconds;
        throw otpError(429, "too_many_requests", "Too many codes were asked for this number in the last few minutes.", "Wait ten minutes before trying this number again.", { retryAfter: after });
      }
      if (Number(n.phone_day) >= OTP.perPhoneDay) throw otpError(429, "too_many_requests", "This number has had its codes for today.", "Try this number again tomorrow.", { retryAfter: retryIn(nextDay(now).getTime(), now.getTime()) });
      if (Number(n.day) >= allowance.perDay) throw otpError(429, "quota_exceeded", `The free allowance of ${allowance.perDay} codes a day is used up.`, "It starts again at midnight UTC.", { retryAfter: retryIn(nextDay(now).getTime(), now.getTime()), resets: nextDay(now).toISOString() });
      if (Number(n.month) >= allowance.perMonth) throw otpError(429, "quota_exceeded", `The free allowance of ${allowance.perMonth} codes a month is used up.`, "It starts again on the 1st (UTC).", { retryAfter: retryIn(nextMonth(now).getTime(), now.getTime()), resets: nextMonth(now).toISOString() });
      const inserted = await c.query(
        `INSERT INTO otp_requests(id,tenant_id,key_id,source,mode,phone,template_key,locale,session_name,status,code_hash,text_hash,max_attempts,reference,idempotency_key,visitor_hash,expires_at)
         VALUES($1,$2,$3,$4,'live',$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13,$14,now()+make_interval(secs=>$15)) RETURNING *`,
        [id, tenantId, key?.id ?? null, source, phone, cfg.template, cfg.locale, sender.session_name, hashCode(id, code), textHash(text), cfg.maxAttempts, ref, idem, visitorHash, cfg.ttlSeconds],
      );
      return inserted.rows[0];
    });
  } catch (error) {
    // the same Idempotency-Key arrived twice at once: the first one wins, the second is told what the first did
    if (error.code === "23505" && idem) {
      const prior = (await query("SELECT * FROM otp_requests WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, idem])).rows[0];
      if (prior) return { ...sendView({ ...prior, resend_seconds: cfg.resendSeconds }), idempotent: true, httpStatus: 200 };
    }
    throw error;
  }

  const fail = async (status, errorCode) => {
    await query("UPDATE otp_requests SET status=$2,error_code=$3,code_hash=NULL WHERE id=$1", [id, status, errorCode]);
  };

  // is the number on WhatsApp at all? Asking costs a moment, so the answer is remembered; "could not tell" goes ahead.
  const found = await onWhatsApp(tenantId, sender.session_name, phone).catch(() => ({ exists: null, jid: null }));
  if (found.exists === false) {
    await fail("failed", "not_on_whatsapp");
    throw otpError(422, "not_on_whatsapp", "This number is not on WhatsApp.", "Offer another way to sign in for this person.");
  }
  const to = found.jid || `${phone}@c.us`;

  // the number's own pace is only used up by a code that is really about to go, so refused requests cannot starve it
  const wait = takeSlot(tenantId, sender.session_name);
  if (wait) {
    await fail("failed", "busy");
    throw otpError(429, "busy", "This number is sending a lot of codes right now.", `Try again in ${wait} seconds.`, { retryAfter: wait });
  }

  expectEcho({ tenantId, sessionName: sender.session_name, text });
  noteOtpSent(tenantId);
  let sent;
  try {
    sent = await provider.sendTextMessage(tenantId, sender.session_name, to, text);
  } catch (error) {
    if (error.code === "SESSION_OFFLINE") {
      await fail("failed", "number_offline");
      throw otpError(503, "number_offline", "The WhatsApp number that sends the codes went offline.", "Open Numbers in Scriwo and reconnect it, then try again.");
    }
    if (error.code === "DELIVERY_UNCERTAIN") {
      // WhatsApp did not confirm. The message may still arrive, so the code stays valid, and it is never sent a second time by us.
      await query("UPDATE otp_requests SET status='uncertain',error_code='delivery_uncertain' WHERE id=$1", [id]);
      const uncertain = (await query("SELECT * FROM otp_requests WHERE id=$1", [id])).rows[0];
      return { ...sendView({ ...uncertain, resend_seconds: cfg.resendSeconds }), httpStatus: 202, note: "WhatsApp did not confirm the message. The code may still arrive: let the person enter it, and wait before asking for another." };
    }
    await fail("failed", "delivery_failed");
    throw otpError(502, "delivery_failed", "WhatsApp did not accept the message.", "Try again in a moment.");
  }

  const ack = Number.isInteger(sent.ack) ? sent.ack : 0;
  const done = (
    await query(
      `UPDATE otp_requests SET status=CASE WHEN $3>=3 THEN 'read' WHEN $3=2 THEN 'delivered' ELSE 'sent' END,provider_message_id=$2,ack=$3,sent_at=now(),
         delivered_at=CASE WHEN $3>=2 THEN now() ELSE NULL END WHERE id=$1 RETURNING *`,
      [id, sent.providerMessageId, ack],
    )
  ).rows[0];
  // a new code replaces the one before it for this number
  await query(
    `UPDATE otp_requests SET status='superseded',code_hash=NULL WHERE tenant_id=$1 AND phone=$2 AND mode='live' AND id<>$3 AND status IN ('pending','sent','delivered','read','uncertain') AND created_at < $4`,
    [tenantId, phone, id, done.created_at],
  );
  await emitOtpEvent(tenantId, "otp.sent", done);
  return { ...sendView({ ...done, resend_seconds: cfg.resendSeconds }), httpStatus: 201 };
}

// ── check ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A person's answer. A wrong, late or repeated code is an answer, not an error: { valid: false, reason }. Only a request that
// cannot be understood or found is an HTTP error.
export async function verifyOtp({ tenantId, key = null, id, phone: rawPhone, code }) {
  const answer = String(code ?? "").trim();
  if (!/^\d{4,8}$/.test(answer)) throw otpError(400, "invalid_code", "The code must be 4 to 8 digits.", "Send only the digits the person typed.");
  let requestId = typeof id === "string" ? id.trim() : "";
  if (!requestId) {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw otpError(400, "missing_request", "Say which code to check: send the id you got when the code was sent, or the phone number.", "Send { id, code }.");
    const latest = (
      // the latest code that can still be checked, else the latest of any kind (to say what became of it)
      await query("SELECT id FROM otp_requests WHERE tenant_id=$1 AND phone=$2 AND mode=$3 ORDER BY (status = ANY($4::text[])) DESC, created_at DESC LIMIT 1", [tenantId, phone, key?.mode || "live", OPEN])
    ).rows[0];
    if (!latest) throw otpError(404, "request_not_found", "No code was sent to that number.", "Send a code first.");
    requestId = latest.id;
  }
  const out = await withTransaction(async (c) => {
    const r = (await c.query("SELECT * FROM otp_requests WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [requestId, tenantId])).rows[0];
    if (!r || (key && r.mode !== key.mode)) throw otpError(404, "request_not_found", "There is no such code request.", "Check the id you got when the code was sent, and that you use the same kind of key (live or test) as when you sent it.");
    const no = (reason, extra = {}) => ({ row: r, valid: false, reason, ...extra });
    if (r.status === "verified") return no("already_used");
    if (r.status === "locked") return no("too_many_attempts", { attemptsLeft: 0 });
    if (r.status === "superseded") return no("superseded");
    if (r.status === "failed") return no("not_sent");
    if (r.status === "expired" || new Date(r.expires_at) <= new Date()) {
      let expiredNow = false;
      if (isOpen(r.status)) {
        await c.query("UPDATE otp_requests SET status='expired',code_hash=NULL WHERE id=$1", [r.id]);
        expiredNow = true;
      }
      return no("expired", { expiredNow });
    }
    const attempts = r.attempts + 1;
    if (r.code_hash && sameHex(hashCode(r.id, answer), r.code_hash)) {
      const updated = await c.query("UPDATE otp_requests SET status='verified',verified_at=now(),attempts=$2,code_hash=NULL WHERE id=$1 RETURNING *", [r.id, attempts]);
      return { row: updated.rows[0], valid: true };
    }
    const locked = attempts >= r.max_attempts;
    const updated = await c.query("UPDATE otp_requests SET attempts=$2,status=CASE WHEN $3 THEN 'locked' ELSE status END,code_hash=CASE WHEN $3 THEN NULL ELSE code_hash END WHERE id=$1 RETURNING *", [r.id, attempts, locked]);
    return { row: updated.rows[0], valid: false, reason: locked ? "too_many_attempts" : "wrong_code", attemptsLeft: Math.max(0, r.max_attempts - attempts), lockedNow: locked };
  });
  if (out.valid) await emitOtpEvent(tenantId, "otp.verified", out.row, { secondsToVerify: seconds(out.row.sent_at, out.row.verified_at) });
  else if (out.lockedNow) await emitOtpEvent(tenantId, "otp.failed", out.row, { reason: "too_many_attempts" });
  else if (out.expiredNow) await emitOtpEvent(tenantId, "otp.expired", out.row);
  return {
    valid: out.valid,
    id: out.row.id,
    ...(out.valid ? { verifiedAt: out.row.verified_at, reference: out.row.reference, phone: `+${out.row.phone}`, secondsToVerify: seconds(out.row.sent_at, out.row.verified_at) } : { reason: out.reason, ...(out.attemptsLeft !== undefined ? { attemptsLeft: out.attemptsLeft } : {}) }),
    row: out.row,
  };
}

export async function statusOf(tenantId, id, key = null) {
  const r = (await query("SELECT * FROM otp_requests WHERE id=$1 AND tenant_id=$2", [String(id ?? ""), tenantId])).rows[0];
  if (!r || (key && r.mode !== key.mode)) throw otpError(404, "request_not_found", "There is no such code request.", "Check the id you got when the code was sent.");
  return requestView(r);
}

// ── the company's own view ─────────────────────────────────────────────────────────────────────────────────────────────

export async function recentRequests(tenantId, limit = 50) {
  const { rows } = await query("SELECT * FROM otp_requests WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2", [tenantId, Math.min(100, Math.max(1, Number(limit) || 50))]);
  return rows.map(requestView);
}

export async function statsOf(tenantId, days = 7) {
  const { rows } = await query(
    `SELECT count(*) FILTER (WHERE status<>'failed') AS sent,
            count(*) FILTER (WHERE delivered_at IS NOT NULL OR ack>=2) AS delivered,
            count(*) FILTER (WHERE status='verified') AS verified,
            count(*) FILTER (WHERE status='failed') AS failed,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (verified_at - sent_at))) FILTER (WHERE status='verified' AND verified_at IS NOT NULL AND sent_at IS NOT NULL) AS median_seconds
     FROM otp_requests WHERE tenant_id=$1 AND mode='live' AND created_at >= now() - make_interval(days=>$2)`,
    [tenantId, days],
  );
  const r = rows[0];
  const sent = Number(r.sent);
  return { days, sent, delivered: Number(r.delivered), verified: Number(r.verified), failed: Number(r.failed), verifiedRate: sent ? Number(r.verified) / sent : null, medianSecondsToVerify: r.median_seconds === null ? null : Math.round(Number(r.median_seconds)) };
}

// has a test code been sent from the studio and checked? (the studio shows a tick when so)
export async function testedOk(tenantId) {
  const { rowCount } = await query("SELECT 1 FROM otp_requests WHERE tenant_id=$1 AND source='dashboard' AND status='verified' LIMIT 1", [tenantId]);
  return rowCount > 0;
}

// ── delivery receipts and the background job ───────────────────────────────────────────────────────────────────────────

// WhatsApp says a message was delivered, read or failed. True when the message was one of ours, so the inbox leaves it alone.
export async function noteOtpAck({ tenantId, providerMessageId, ack }) {
  if (!providerMessageId || !Number.isInteger(ack) || !(await hasRecentOtp(tenantId))) return false;
  const { rows } = await query(
    `WITH old AS (SELECT id,delivered_at,status AS was FROM otp_requests WHERE tenant_id=$1 AND provider_message_id=$2 FOR UPDATE)
     UPDATE otp_requests r SET ack=GREATEST(r.ack,$3),
       delivered_at=CASE WHEN $3>=2 AND r.delivered_at IS NULL THEN now() ELSE r.delivered_at END,
       status=CASE WHEN r.status IN ('sent','delivered') AND $3>=3 THEN 'read' WHEN r.status='sent' AND $3=2 THEN 'delivered' WHEN r.status IN ('sent','uncertain') AND $3<0 THEN 'failed' ELSE r.status END,
       error_code=CASE WHEN r.status IN ('sent','uncertain') AND $3<0 THEN 'delivery_failed' ELSE r.error_code END
     FROM old WHERE r.id=old.id RETURNING r.*,old.delivered_at AS was_delivered_at,old.was AS was_status`,
    [tenantId, providerMessageId, ack],
  );
  const r = rows[0];
  if (!r) return false;
  if (ack >= 2 && !r.was_delivered_at) await emitOtpEvent(tenantId, "otp.delivered", r);
  if (ack < 0 && r.status === "failed" && r.was_status !== "failed") await emitOtpEvent(tenantId, "otp.failed", r, { reason: "delivery_failed" });
  return true;
}

let lastPrune = 0;
export async function pumpOtp() {
  const { rows } = await query(
    `WITH due AS (SELECT id FROM otp_requests WHERE status IN ('pending','sent','delivered','read','uncertain') AND expires_at < now() ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED)
     UPDATE otp_requests r SET status='expired',code_hash=NULL FROM due WHERE r.id=due.id RETURNING r.*`,
  );
  for (const r of rows) await emitOtpEvent(r.tenant_id, "otp.expired", r);
  if (Date.now() - lastPrune > 3600000) {
    lastPrune = Date.now();
    await query("DELETE FROM otp_requests WHERE created_at < now() - make_interval(days=>$1)", [OTP.retentionDays]);
  }
}

export { TEMPLATES, TEMPLATE_KEYS, LOCALES };
