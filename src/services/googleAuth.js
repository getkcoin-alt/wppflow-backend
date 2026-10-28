import crypto from "node:crypto";
import { query } from "../db/index.js";
import { ENV } from "../config/env.js";
import { registerTenantAndUser } from "./authService.js";

// "Continue with Google". The ordinary authorisation-code flow, run by this server:
//   1. /api/auth/google/start sends the browser to Google with a one-time state, a nonce and a PKCE challenge, all also kept in
//      short-lived cookies that only this browser has;
//   2. Google sends the browser back to /api/auth/google/callback with a code;
//   3. this server swaps the code for the person's identity over TLS, using the client secret, and checks it;
//   4. the person is signed in, or given a new Free workspace, exactly as if they had used a password.
// The identity comes straight from Google's token endpoint over TLS, so (as the OpenID specification allows) its signature is
// not separately checked; everything inside it that matters is.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const redirectUri = () => process.env.GOOGLE_REDIRECT_URI || `${ENV.APP_URL}/api/auth/google/callback`;

let doFetch = (url, init) => fetch(url, init);
export const setGoogleFetch = (fake) => {
  doFetch = fake || ((url, init) => fetch(url, init));
};

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest();

// What a person came to do, carried through Google and back: which plan they chose on the pricing page, if any.
// Only known words are kept, so nothing else can be smuggled into the address they are sent back to.
export function cleanIntent({ plan, interval } = {}) {
  const p = String(plan || "").toLowerCase();
  const i = String(interval || "").toLowerCase();
  return {
    plan: /^[a-z0-9_-]{1,30}$/.test(p) ? p : "",
    interval: i === "annual" || i === "yearly" ? "annual" : i === "monthly" ? "monthly" : "",
  };
}

// The cookies and the address that start a sign-in.
export function startSignIn(intent) {
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: b64url(sha256(verifier)),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { url: url.toString(), cookie: { state, nonce, verifier, ...cleanIntent(intent) } };
}

const same = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

export class GoogleSignInError extends Error {
  constructor(code, detail = "") {
    super(detail || code);
    this.code = code;
  }
}

// The person's identity from a code, or the reason it cannot be trusted.
export async function identityFromCode({ code, state, saved }) {
  if (!saved || !same(state, saved.state)) throw new GoogleSignInError("expired", "the sign-in did not start here, or took too long");
  if (typeof code !== "string" || !code) throw new GoogleSignInError("failed", "no code");
  let res;
  try {
    res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
        code_verifier: saved.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new GoogleSignInError("failed", `Google could not be reached: ${e.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.id_token !== "string") throw new GoogleSignInError("failed", `Google refused the code (${body.error || res.status})`);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body.id_token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    throw new GoogleSignInError("failed", "the identity was unreadable");
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) throw new GoogleSignInError("failed", "the identity was meant for another app");
  if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss)) throw new GoogleSignInError("failed", "the identity came from somewhere else");
  if (!(claims.exp > now - 60)) throw new GoogleSignInError("failed", "the identity has expired");
  if (!same(claims.nonce, saved.nonce)) throw new GoogleSignInError("failed", "the nonce did not match");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 64) throw new GoogleSignInError("failed", "no subject");
  const email = String(claims.email || "").trim().toLowerCase();
  if (!email || claims.email_verified !== true) throw new GoogleSignInError("unverified", "Google has not verified this e-mail address");
  return { subject: claims.sub, email, name: String(claims.name || claims.given_name || email.split("@")[0]).trim().slice(0, 255) };
}

// The Scriwo person for a Google identity: the one already linked, else the one with the same verified e-mail (now linked),
// else a new person with a new Free workspace, like signing up on their own.
export async function personFor(identity) {
  const linked = (await query("SELECT u.* FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.provider='google' AND i.subject=$1", [identity.subject])).rows[0];
  let user = linked;
  let created = false;
  if (!user) {
    user = (await query("SELECT * FROM users WHERE lower(email)=$1", [identity.email])).rows[0];
    if (!user) {
      if (!ENV.ALLOW_PUBLIC_SIGNUP) throw new GoogleSignInError("closed", "self-service sign-up is switched off");
      // no password: a Google person who wants one can use "Forgot password"
      const made = await registerTenantAndUser({
        name: identity.name,
        email: identity.email,
        password: crypto.randomBytes(48).toString("base64url"),
        companyName: `${identity.name}'s Workspace`,
        plan: "Free",
        sessionsLimit: 1,
      });
      user = (await query("SELECT * FROM users WHERE id=$1", [made.user.id])).rows[0];
      created = true;
    }
    await query(
      "INSERT INTO user_identities(provider,subject,user_id,email) VALUES('google',$1,$2,$3) ON CONFLICT DO NOTHING",
      [identity.subject, user.id, identity.email],
    );
  } else {
    await query("UPDATE user_identities SET last_used_at=now(),email=$2 WHERE provider='google' AND subject=$1", [identity.subject, identity.email]);
  }
  if (user.status !== "active") throw new GoogleSignInError("disabled", "the account is not active");
  return { user, created };
}
