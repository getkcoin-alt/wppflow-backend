import crypto from "node:crypto";
import { query } from "../db/index.js";
import { ENV } from "../config/env.js";
import { defaultWhatsAppProvider } from "./whatsapp/WhatsAppProvider.js";

// Profile pictures in the inbox.
//
// What used to happen: the chat list was synced with whatever address WhatsApp had attached to each contact, and the browser
// was given that address. The attachment is deprecated and usually empty, and when it is there it is a signed address that
// stops working within days, so most chats showed initials. Now the browser is given our own address for the picture, and
// this service keeps the picture itself: it asks WhatsApp for the current one, fetches the image, and remembers it.
//
// Because WhatsApp's linked-device link is easy to upset, asking is gentle: only for a chat somebody is looking at, one
// request at a time per number with a pause between, never more than a few waiting, and "no picture" is remembered too.

export const LIMITS = {
  freshMs: 7 * 24 * 3600 * 1000, // a picture is looked up again after a week
  missingMs: 12 * 3600 * 1000, // someone without one is asked about again after half a day
  maxBytes: 256 * 1024,
  gapMs: 800, // between two questions to WhatsApp on one number
  queueMax: 25, // more than this waiting on one number are told to try later (about twenty seconds of waiting)
  providerMs: 10_000,
  fetchMs: 8_000,
};
export const setAvatarLimits = (patch) => Object.assign(LIMITS, patch);
// "Could not find out just now" (WhatsApp offline, busy, or the picture would not download), as opposed to null, which means
// WhatsApp said this person has no picture. The browser is told to ask again soon for the first and much later for the second.
export const LATER = Symbol("later");

// Tests stand in for WhatsApp and for the network.
let provider = defaultWhatsAppProvider;
let fetchImage = (url, init) => fetch(url, init);
export const setAvatarProvider = (fake) => {
  provider = fake || defaultWhatsAppProvider;
};
export const setAvatarFetch = (fake) => {
  fetchImage = fake || ((url, init) => fetch(url, init));
};

// ── The address the browser is given ─────────────────────────────────────────────────────────────
// An <img> cannot carry the sign-in token, so the address itself is the permission: it names the chat and carries a
// signature only this server can make, bound to the company, so it cannot be changed to reach another chat.
const signingKey = () => crypto.createHash("sha256").update(`avatar-url-v1:${ENV.JWT_SECRET}`).digest();
const signature = (kind, tenantId, id) => crypto.createHmac("sha256", signingKey()).update(`${kind}:${tenantId}:${id}`).digest("hex").slice(0, 32);
export const KINDS = ["chat", "contact"];
export function avatarUrl(kind, row) {
  if (!row?.id || !row.tenant_id) return "";
  return `/api/avatars/${kind}/${encodeURIComponent(row.id)}?s=${signature(kind, row.tenant_id, row.id)}`;
}
export function signatureMatches(kind, tenantId, id, given) {
  const want = Buffer.from(signature(kind, tenantId, id));
  const got = Buffer.from(String(given ?? ""));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ── What is asked about ──────────────────────────────────────────────────────────────────────────
// The chat or contact named by an address, with the company it belongs to; null when there is no such thing.
export async function targetOf(kind, id) {
  if (kind === "chat") {
    const row = (await query("SELECT id,tenant_id,session_name,provider_chat_id,avatar FROM conversations WHERE id=$1", [id])).rows[0];
    return row && { tenantId: row.tenant_id, sessionName: row.session_name, chatId: row.provider_chat_id, storedUrl: row.avatar || "", row };
  }
  const row = (await query("SELECT id,tenant_id,phone,avatar FROM contacts WHERE id=$1", [id])).rows[0];
  if (!row || !/^\d{6,20}$/.test(row.phone || "")) return null;
  const session = (await query("SELECT session_name FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY (status='CONNECTED') DESC, created_at LIMIT 1", [row.tenant_id])).rows[0];
  return { tenantId: row.tenant_id, sessionName: session?.session_name || "", chatId: `${row.phone}@c.us`, storedUrl: row.avatar || "", row };
}

// ── Fetching the image ───────────────────────────────────────────────────────────────────────────
// The address comes from WhatsApp, not from a person, but it is still only followed if it is an ordinary https address on
// one of WhatsApp's own hosts: this server will not be made to fetch anything else.
const HOSTS = /(^|\.)(whatsapp\.net|whatsapp\.com|fbcdn\.net)$/i;
function checkedUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not an address");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !HOSTS.test(url.hostname)) throw new Error("not a WhatsApp picture address");
  return url;
}
// What the bytes really are, whatever the server called them: only ordinary picture formats are ever kept or sent on.
function imageType(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length > 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}
async function download(raw) {
  const url = checkedUrl(raw);
  const res = await fetchImage(url, { redirect: "error", signal: AbortSignal.timeout(LIMITS.fetchMs), headers: { accept: "image/*" } });
  if (!res.ok) throw new Error(`WhatsApp answered ${res.status}`);
  if (Number(res.headers.get("content-length")) > LIMITS.maxBytes) throw new Error("the picture is too large");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > LIMITS.maxBytes) throw new Error("the picture is too large");
  const type = imageType(bytes);
  if (!type) throw new Error("not a picture");
  return { bytes, type };
}

// ── Asking WhatsApp, gently ──────────────────────────────────────────────────────────────────────
const lanes = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function throttled(laneKey, job) {
  const lane = lanes.get(laneKey) || { tail: Promise.resolve(), waiting: 0, last: 0 };
  if (lane.waiting >= LIMITS.queueMax) return Promise.reject(new Error("busy"));
  lane.waiting += 1;
  const run = lane.tail.then(async () => {
    try {
      const wait = lane.last + LIMITS.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      let timer;
      const late = new Promise((_, no) => {
        timer = setTimeout(() => no(new Error("WhatsApp did not answer")), LIMITS.providerMs);
      });
      try {
        return await Promise.race([job(), late]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      lane.last = Date.now();
      lane.waiting -= 1;
    }
  });
  lane.tail = run.catch(() => {});
  lanes.set(laneKey, lane);
  return run;
}

const save = (tenantId, chatId, status, picture) =>
  query(
    `INSERT INTO profile_pictures(tenant_id,chat_id,status,content_type,image,fetched_at) VALUES($1,$2,$3,$4,$5,now())
     ON CONFLICT (tenant_id,chat_id) DO UPDATE SET status=EXCLUDED.status,content_type=EXCLUDED.content_type,image=EXCLUDED.image,fetched_at=now()`,
    [tenantId, chatId, status, picture?.type || null, picture?.bytes || null],
  );
const served = (row) => ({ bytes: row.image, type: row.content_type, fetchedAt: new Date(row.fetched_at) });

async function load({ tenantId, sessionName, chatId, storedUrl }) {
  const row = (await query("SELECT status,content_type,image,fetched_at FROM profile_pictures WHERE tenant_id=$1 AND chat_id=$2", [tenantId, chatId])).rows[0];
  const age = row ? Date.now() - new Date(row.fetched_at).getTime() : Infinity;
  if (row?.status === "ok" && age < LIMITS.freshMs) return served(row);
  if (row?.status === "none" && age < LIMITS.missingMs) return null;

  // 1. ask WhatsApp for the current picture
  let url = null;
  try {
    url = await throttled(`${tenantId}|${sessionName}`, () => provider.getProfilePicUrl(tenantId, sessionName, chatId));
  } catch {
    /* the number is offline, busy or slow: use what we have */
  }
  if (url === "") {
    // WhatsApp answered: this person has no picture (or hides it)
    await save(tenantId, chatId, "none", null);
    return null;
  }
  // 2. no answer: the address stored by the last sync may still work, and an old picture is better than none
  const address = url || (row?.status === "ok" ? "" : storedUrl);
  if (address) {
    try {
      const picture = await download(address);
      await save(tenantId, chatId, "ok", picture);
      return { ...picture, fetchedAt: new Date() };
    } catch (error) {
      console.warn(`Profile picture for ${chatId} could not be fetched: ${error.message}`);
    }
  }
  return row?.status === "ok" ? served(row) : LATER;
}

// One lookup at a time for one chat, however many browsers ask at once.
const inflight = new Map();
export function pictureFor(target) {
  const key = `${target.tenantId}|${target.chatId}`;
  if (!inflight.has(key)) inflight.set(key, load(target).finally(() => inflight.delete(key)));
  return inflight.get(key);
}
