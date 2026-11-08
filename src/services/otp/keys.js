import crypto from "node:crypto";
import { query } from "../../db/index.js";
import { failWith } from "../../middleware/http.js";

// An error the caller can act on: what happened, in words, and what to do about it. { status, message, code, fix, ...extra }
export const otpError = (status, code, message, fix, extra = {}) => failWith(status, message, { code, fix, ...extra });

// Keys of their own, not api_keys: the API keys count as a manager on routes that do not check scope, and a key that can only
// send and check codes must be able to do nothing else. otp_sk_ is secret (a server), otp_pk_ is public (a web page).
export const KEY_PATTERN = /^otp_(sk|pk)_(live|test)_[a-f0-9]{40}$/;
const hash = (key) => crypto.createHash("sha256").update(key).digest("hex");
export const newKeyText = (kind, mode) => `otp_${kind === "public" ? "pk" : "sk"}_${mode}_${crypto.randomBytes(20).toString("hex")}`;

// The websites a public key may be used on, as origins ("https://shop.example.com"). A page is its origin: no path, https only
// (plain http only for localhost, so a developer can try it on their own machine).
export function cleanOrigins(list, { required = false } = {}) {
  if (list === undefined || list === null) list = [];
  if (!Array.isArray(list) || list.length > 10) throw otpError(400, "invalid_origins", "List up to 10 websites.", "For example https://shop.example.com");
  const out = [];
  for (const raw of list) {
    let url;
    try {
      url = new URL(String(raw).trim());
    } catch {
      throw otpError(400, "invalid_origins", `"${String(raw).slice(0, 60)}" is not a website address.`, "Use the full address, for example https://shop.example.com");
    }
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && local)))
      throw otpError(400, "invalid_origins", `"${url.origin}" cannot be used.`, "Use https:// addresses (http:// is only allowed for localhost).");
    if (!out.includes(url.origin)) out.push(url.origin);
  }
  if (required && !out.length) throw otpError(400, "origins_required", "Say which website the widget will run on.", "For example https://shop.example.com");
  return out;
}

export async function createOtpKey({ tenantId, userId = null, name, kind = "secret", mode = "live", origins = [] }) {
  if (!["secret", "public"].includes(kind)) throw otpError(400, "invalid_key", "A key is secret or public.", "Use a secret key on your server, a public key on a web page.");
  if (!["live", "test"].includes(mode)) throw otpError(400, "invalid_key", "A key is live or test.", "Use a test key while you build.");
  const title = String(name ?? "").trim();
  if (!title || title.length > 100) throw otpError(400, "invalid_name", "Give the key a name (up to 100 characters).", "For example: My website");
  // a live public key must say where it works; a test one works anywhere because it sends nothing
  const allowed = kind === "public" ? cleanOrigins(origins, { required: mode === "live" }) : [];
  const text = newKeyText(kind, mode);
  const { rows } = await query(
    "INSERT INTO otp_keys(id,tenant_id,name,kind,mode,key_hash,prefix,allowed_origins,created_by) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,created_at",
    [tenantId, title, kind, mode, hash(text), text.slice(0, 16), JSON.stringify(allowed), userId],
  );
  return { id: rows[0].id, key: text, name: title, kind, mode, prefix: text.slice(0, 16), allowedOrigins: allowed, createdAt: rows[0].created_at };
}

export const keyView = (r) => ({ id: r.id, name: r.name, kind: r.kind, mode: r.mode, prefix: r.prefix, allowedOrigins: r.allowed_origins || [], createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at });
export async function listOtpKeys(tenantId) {
  const { rows } = await query("SELECT id,name,kind,mode,prefix,allowed_origins,created_at,last_used_at,revoked_at FROM otp_keys WHERE tenant_id=$1 ORDER BY created_at DESC", [tenantId]);
  return rows.map(keyView);
}
export async function revokeOtpKey(tenantId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return false;
  const { rowCount } = await query("UPDATE otp_keys SET revoked_at=now() WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL", [id, tenantId]);
  return rowCount > 0;
}

// The key a caller sent, if it is one of ours, not revoked, and its company is active
export async function findOtpKey(text) {
  if (!KEY_PATTERN.test(String(text ?? ""))) return null;
  const { rows } = await query(
    "SELECT k.* FROM otp_keys k JOIN tenants t ON t.id=k.tenant_id WHERE k.key_hash=$1 AND k.revoked_at IS NULL AND t.status='active'",
    [hash(text)],
  );
  const key = rows[0] || null;
  // "last used" is only to show a person; once a minute is plenty
  if (key && (!key.last_used_at || Date.now() - new Date(key.last_used_at).getTime() > 60000)) query("UPDATE otp_keys SET last_used_at=now() WHERE id=$1", [key.id]).catch(() => {});
  return key;
}

// Middleware: the key in "Authorization: Bearer ..." must be one of these kinds
export const requireOtpKey = ({ kinds = ["secret"] } = {}) => async (req, res, next) => {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) throw otpError(401, "missing_key", "No key was sent.", "Send your secret key as: Authorization: Bearer otp_sk_live_...");
    const key = await findOtpKey(token);
    if (!key) throw otpError(401, "invalid_key", "This key is not valid.", "Check you copied all of it and that it was not revoked. Keys are created under Developers, Free OTP.");
    if (!kinds.includes(key.kind))
      throw otpError(403, "wrong_key_kind", key.kind === "public" ? "A public key cannot be used here." : "A secret key cannot be used here.", key.kind === "public" ? "Use your secret key (otp_sk_...) from your server." : "Use the public key (otp_pk_...) in the browser widget.");
    req.otpKey = key;
    req.tenantId = key.tenant_id;
    next();
  } catch (error) {
    next(error);
  }
};
