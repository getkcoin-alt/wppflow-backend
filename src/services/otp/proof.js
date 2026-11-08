import { query } from "../../db/index.js";
import { OTP, hmac, sameHex } from "./config.js";
import { otpError } from "./keys.js";

// The widget runs in a visitor's browser, so what it learns ("this phone was verified") cannot be taken on trust by the company's
// server. It is given a proof: the request, the company and the phone, signed by Scriwo, good for ten minutes and for one use. The
// company's server hands it back to us (POST /api/otp/proof/verify) and we say yes or no.
const b64 = (value) => Buffer.from(value).toString("base64url");

export function makeProof(row, now = Date.now()) {
  const payload = b64(JSON.stringify({ v: 1, id: row.id, t: row.tenant_id, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + OTP.proofSeconds }));
  return `otp_proof_${payload}.${hmac("proof", payload)}`;
}

const parse = (proof) => {
  const m = /^otp_proof_([A-Za-z0-9_-]{10,600})\.([a-f0-9]{64})$/.exec(String(proof ?? ""));
  if (!m || !sameHex(hmac("proof", m[1]), m[2])) return null;
  try {
    const claim = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    return claim && claim.v === 1 && typeof claim.id === "string" && typeof claim.t === "string" ? claim : null;
  } catch {
    return null;
  }
};

export async function consumeProof({ tenantId, proof, now = Date.now() }) {
  const claim = parse(proof);
  // a proof that is not ours, or is another company's, is just "not valid": nothing is said about why
  if (!claim || claim.t !== tenantId) throw otpError(400, "invalid_proof", "That proof is not valid.", "Send the proof exactly as the widget gave it.");
  if (claim.exp * 1000 < now) return { valid: false, reason: "expired" };
  const { rows } = await query(
    "UPDATE otp_requests SET proof_used_at=now() WHERE id=$1 AND tenant_id=$2 AND status='verified' AND proof_used_at IS NULL RETURNING id,phone,reference,verified_at,mode",
    [claim.id, tenantId],
  );
  if (!rows[0]) return { valid: false, reason: "already_used" };
  return { valid: true, id: rows[0].id, phone: `+${rows[0].phone}`, reference: rows[0].reference, verifiedAt: rows[0].verified_at, mode: rows[0].mode };
}
