import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { setAvatarFetch, setAvatarLimits, setAvatarProvider, LIMITS } from "../src/services/avatarService.js";
import { closeSessions } from "../src/services/sessionService.js";

// the smallest real pictures: a JPEG header, a PNG header and a WebP header, then some bytes
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-picture-of-asha")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-picture")]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]);
const URL_A = "https://pps.whatsapp.net/v/t61/asha.jpg?oe=abc";

// WhatsApp and the network, scripted and counted
function world() {
  const asked = [];
  const fetched = [];
  const w = {
    asked,
    fetched,
    pictures: {}, // chat id -> address, "" for none, or an Error
    images: {}, // address -> { bytes, type, status }
    gap: [],
    provider: {
      getProfilePicUrl: async (tenantId, session, chatId) => {
        asked.push({ tenantId, session, chatId, at: Date.now() });
        const v = w.pictures[chatId];
        if (v instanceof Error) throw v;
        return v ?? "";
      },
    },
    fetch: async (url, init) => {
      fetched.push({ url: String(url), init });
      const img = w.images[String(url)];
      if (!img) return new Response("no", { status: 404 });
      return new Response(img.bytes, { status: img.status || 200, headers: { "content-type": img.type || "image/jpeg", ...(img.headers || {}) } });
    },
  };
  setAvatarProvider(w.provider);
  setAvatarFetch(w.fetch);
  return w;
}

test("Profile pictures: fetched from WhatsApp, kept, and shown through the server's own address", async (t) => {
  const original = { ...LIMITS };
  t.after(async () => {
    setAvatarProvider(undefined);
    setAvatarFetch(undefined);
    setAvatarLimits(original);
    await closeSessions(io);
    io.close();
  });
  setAvatarLimits({ gapMs: 0 });
  const w = world();

  const make = async (name, email) => {
    const o = await registerTenantAndUser({ name, email, password: "Password@123", companyName: `${name} Co` });
    const tenantId = o.tenant.id;
    await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [tenantId]);
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,'line',$2,'CONNECTED')", [tenantId, o.user.id]);
    const auth = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
    let n = 0;
    const hear = async (phone, who, remoteSuffix = "@c.us") => {
      n += 1;
      await handleIncomingMessage({ tenantId, sessionName: "line", msg: { providerMessageId: `true_${phone}_${n}`, fromMe: false, remoteId: `${phone}${remoteSuffix}`, rawType: "chat", type: "text", text: "Hello", timestampEpoch: Math.floor(Date.now() / 1000), senderName: who, ack: 2 } });
    };
    const chats = async () => (await request(app).get("/api/conversations").set(auth)).body.conversations;
    const chatOf = async (phone) => (await chats()).find((c) => c.phone === phone);
    return { tenantId, auth, hear, chats, chatOf };
  };
  const A = await make("Olivia", "olivia@pics.test");
  const B = await make("Bashir", "bashir@pics.test");
  await A.hear("447700900001", "Asha Rao");
  await A.hear("447700900002", "Ben Hidden");
  await B.hear("447700900001", "Asha In Another Company");
  const asha = await A.chatOf("447700900001");
  const ben = await A.chatOf("447700900002");
  const get = (path) => request(app).get(path).buffer(true).parse((res, cb) => { const parts = []; res.on("data", (d) => parts.push(d)); res.on("end", () => cb(null, Buffer.concat(parts))); });

  await t.test("the inbox is given the server's own address for the picture, signed for that chat", async () => {
    assert.match(asha.avatar, /^\/api\/avatars\/chat\/[\w-]+\?s=[0-9a-f]{32}$/);
    assert.notEqual(asha.avatar, ben.avatar);
    const single = await request(app).get(`/api/conversations/${asha.id}`).set(A.auth);
    assert.equal((single.body.conversation || single.body).avatar, asha.avatar, "the same address every time, so the browser can keep the picture");
    assert.equal(w.asked.length, 0, "listing chats does not ask WhatsApp for anything");
  });

  await t.test("the first look asks WhatsApp, fetches the picture, and serves it with safe headers", async () => {
    w.pictures["447700900001@c.us"] = URL_A;
    w.images[URL_A] = { bytes: JPEG };
    const res = await get(asha.avatar);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, JPEG);
    assert.equal(res.headers["content-type"], "image/jpeg");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["cache-control"], "private, max-age=3600");
    assert.equal(res.headers["cross-origin-resource-policy"], "cross-origin");
    assert.deepEqual(w.asked.map((a) => [a.tenantId, a.session, a.chatId]), [[A.tenantId, "line", "447700900001@c.us"]]);
    assert.equal(w.fetched.length, 1);
    assert.equal(w.fetched[0].init.redirect, "error", "a redirect is never followed");
  });

  await t.test("after that it is kept: nobody asks WhatsApp again, and the browser can check it is unchanged", async () => {
    const again = await get(asha.avatar);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, JPEG);
    assert.equal(w.asked.length, 1);
    assert.equal(w.fetched.length, 1);
    const check = await request(app).get(asha.avatar).set("If-None-Match", again.headers.etag);
    assert.equal(check.status, 304);
  });

  await t.test("someone with no picture gets none, is not asked about again at once, and is asked again after half a day", async () => {
    w.pictures["447700900002@c.us"] = "";
    assert.equal((await get(ben.avatar)).status, 404);
    assert.equal((await get(ben.avatar)).status, 404);
    assert.equal(w.asked.filter((a) => a.chatId === "447700900002@c.us").length, 1);
    w.pictures["447700900002@c.us"] = "https://pps.whatsapp.net/v/t61/ben.png";
    w.images["https://pps.whatsapp.net/v/t61/ben.png"] = { bytes: PNG, type: "image/png" };
    assert.equal((await get(ben.avatar)).status, 404, "still remembered as having none");
    await query("UPDATE profile_pictures SET fetched_at=now()-interval '13 hours' WHERE tenant_id=$1 AND chat_id='447700900002@c.us'", [A.tenantId]);
    const now = await get(ben.avatar);
    assert.equal(now.status, 200, "they have added one");
    assert.equal(now.headers["content-type"], "image/png");
  });

  await t.test("a picture is looked up again after a week; if WhatsApp cannot be reached the old one is shown", async () => {
    await query("UPDATE profile_pictures SET fetched_at=now()-interval '8 days' WHERE tenant_id=$1 AND chat_id='447700900001@c.us'", [A.tenantId]);
    w.pictures["447700900001@c.us"] = new Error("WhatsApp session is offline");
    const before = w.asked.length;
    const old = await get(asha.avatar);
    assert.equal(old.status, 200);
    assert.deepEqual(old.body, JPEG, "the old picture is better than none");
    assert.equal(w.asked.length, before + 1, "it did try");
    const row = (await query("SELECT fetched_at FROM profile_pictures WHERE tenant_id=$1 AND chat_id='447700900001@c.us'", [A.tenantId])).rows[0];
    assert.ok(Date.now() - new Date(row.fetched_at).getTime() > 7 * 86400000, "a failed refresh does not pretend the picture is fresh");
    // when WhatsApp answers again, the new picture replaces it
    w.pictures["447700900001@c.us"] = "https://pps.whatsapp.net/v/t61/asha-new.webp";
    w.images["https://pps.whatsapp.net/v/t61/asha-new.webp"] = { bytes: WEBP, type: "image/webp" };
    const fresh = await get(asha.avatar);
    assert.deepEqual(fresh.body, WEBP);
    assert.equal(fresh.headers["content-type"], "image/webp");
    // and when they take their picture down, it goes
    await query("UPDATE profile_pictures SET fetched_at=now()-interval '8 days' WHERE tenant_id=$1 AND chat_id='447700900001@c.us'", [A.tenantId]);
    w.pictures["447700900001@c.us"] = "";
    assert.equal((await get(asha.avatar)).status, 404);
  });

  await t.test("when WhatsApp cannot be asked and nothing is kept, the address stored by the last sync is tried, and a failure stores nothing", async () => {
    await A.hear("447700900003", "Cara Offline");
    const cara = await A.chatOf("447700900003");
    w.pictures["447700900003@c.us"] = new Error("WhatsApp session is offline");
    await query("UPDATE conversations SET avatar='https://pps.whatsapp.net/v/t61/cara-stored.jpg' WHERE id=$1", [cara.id]);
    w.images["https://pps.whatsapp.net/v/t61/cara-stored.jpg"] = { bytes: JPEG };
    assert.equal((await get(cara.avatar)).status, 200);
    await A.hear("447700900004", "Dev Offline");
    const dev = await A.chatOf("447700900004");
    w.pictures["447700900004@c.us"] = new Error("WhatsApp session is offline");
    const outage = await get(dev.avatar);
    assert.equal(outage.status, 404);
    assert.equal(outage.headers["cache-control"], "private, max-age=30", "an outage is worth asking about again soon");
    w.pictures["447700900004@c.us"] = "";
    await query("DELETE FROM profile_pictures WHERE tenant_id=$1", [A.tenantId]);
    const missing = await get(dev.avatar);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers["cache-control"], "private, max-age=300", "but 'no picture' is remembered for longer");
    await query("DELETE FROM profile_pictures WHERE tenant_id=$1 AND chat_id='447700900004@c.us'", [A.tenantId]);
    w.pictures["447700900004@c.us"] = new Error("WhatsApp session is offline");
    assert.equal((await query("SELECT count(*)::int AS n FROM profile_pictures WHERE tenant_id=$1 AND chat_id='447700900004@c.us'", [A.tenantId])).rows[0].n, 0, "an outage is not remembered as 'no picture'");
  });

  await t.test("an address can only be used for its own chat, and a wrong one is answered like a chat that does not exist", async () => {
    w.asked.length = 0;
    const sig = (u) => u.split("s=")[1];
    const attempts = [
      `/api/avatars/chat/${asha.id}`,
      `/api/avatars/chat/${asha.id}?s=`,
      `/api/avatars/chat/${asha.id}?s=${"0".repeat(32)}`,
      `/api/avatars/chat/${ben.id}?s=${sig(asha.avatar)}`, // another chat of the same company
      `/api/avatars/contact/${asha.contactId}?s=${sig(asha.avatar)}`, // the same signature for another kind of thing
      `/api/avatars/chat/does-not-exist?s=${sig(asha.avatar)}`,
      `/api/avatars/chat/${asha.id}?s=${sig(asha.avatar)}&s=${sig(asha.avatar)}`,
      `/api/avatars/other/${asha.id}?s=${sig(asha.avatar)}`,
      `/api/avatars/chat/${encodeURIComponent("../../etc/passwd")}?s=${sig(asha.avatar)}`,
    ];
    for (const path of attempts) {
      const res = await request(app).get(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.body && Object.keys(res.body).length === 0, true, "nothing is said about why");
    }
    assert.equal(w.asked.length, 0, "WhatsApp was not asked on behalf of a forged address");
  });

  await t.test("two companies with a chat of the same number keep separate pictures", async () => {
    const theirs = await B.chatOf("447700900001");
    w.pictures["447700900001@c.us"] = "https://pps.whatsapp.net/v/t61/other.jpg";
    w.images["https://pps.whatsapp.net/v/t61/other.jpg"] = { bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("their-asha")]) };
    const res = await get(theirs.avatar);
    assert.equal(res.status, 200);
    assert.match(res.body.toString("latin1"), /their-asha/);
    assert.notEqual(theirs.avatar, asha.avatar);
    assert.equal((await query("SELECT count(*)::int AS n FROM profile_pictures WHERE chat_id='447700900001@c.us'")).rows[0].n >= 1, true);
    const tenantsWithRows = (await query("SELECT DISTINCT tenant_id FROM profile_pictures WHERE chat_id='447700900001@c.us'")).rows.map((r) => r.tenant_id);
    assert.deepEqual(tenantsWithRows.includes(B.tenantId), true);
    assert.equal((await query("SELECT count(*)::int AS n FROM profile_pictures WHERE tenant_id=$1 AND image::text LIKE '%their%'", [A.tenantId])).rows[0].n, 0, "their picture is not stored under our company");
  });

  await t.test("only ordinary https addresses on WhatsApp's own hosts are ever fetched", async () => {
    let n = 0;
    const chatFor = async (address) => {
      n += 1;
      const phone = `4477009100${n.toString().padStart(2, "0")}`;
      await A.hear(phone, `Probe ${n}`);
      const chat = await A.chatOf(phone);
      w.pictures[`${phone}@c.us`] = address;
      return chat;
    };
    const before = w.fetched.length;
    for (const bad of [
      "http://pps.whatsapp.net/v/x.jpg",
      "https://169.254.169.254/latest/meta-data/",
      "https://evil.example/x.jpg",
      "https://pps.whatsapp.net.evil.example/x.jpg",
      "https://notwhatsapp.net/x.jpg",
      "https://user:pass@pps.whatsapp.net/x.jpg",
      "https://pps.whatsapp.net:8443/x.jpg",
      "file:///etc/passwd",
      "not an address",
    ]) {
      const chat = await chatFor(bad);
      assert.equal((await get(chat.avatar)).status, 404, bad);
    }
    assert.equal(w.fetched.length, before, "not one of them was fetched");
    // and the genuine kinds of WhatsApp address are
    const ok = await chatFor("https://media-dxb5-1.cdn.whatsapp.net/v/t61/x.jpg");
    w.images["https://media-dxb5-1.cdn.whatsapp.net/v/t61/x.jpg"] = { bytes: JPEG };
    assert.equal((await get(ok.avatar)).status, 200);
  });

  await t.test("only real, small pictures are kept: the bytes decide, not what the server called them", async () => {
    let n = 0;
    const serve = async (image) => {
      n += 1;
      const phone = `4477009200${n.toString().padStart(2, "0")}`;
      await A.hear(phone, `Image ${n}`);
      const chat = await A.chatOf(phone);
      const address = `https://pps.whatsapp.net/v/t61/probe-${n}.jpg`;
      w.pictures[`${phone}@c.us`] = address;
      w.images[address] = image;
      return get(chat.avatar);
    };
    assert.equal((await serve({ bytes: Buffer.from("<html><script>alert(1)</script></html>"), type: "image/jpeg" })).status, 404, "a page called a picture");
    assert.equal((await serve({ bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), type: "image/svg+xml" })).status, 404, "a vector image can carry a script");
    assert.equal((await serve({ bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(LIMITS.maxBytes)]), type: "image/jpeg" })).status, 404, "too large");
    assert.equal((await serve({ bytes: JPEG, status: 403 })).status, 404, "WhatsApp refused");
    assert.equal((await serve({ bytes: JPEG, headers: { "content-length": String(LIMITS.maxBytes + 1) } })).status, 404, "it says it is too large");
    const lie = await serve({ bytes: PNG, type: "image/jpeg" });
    assert.equal(lie.status, 200);
    assert.equal(lie.headers["content-type"], "image/png", "it is served as what it is");
  });

  await t.test("a crowd looking at one chat at once costs one question to WhatsApp", async () => {
    await A.hear("447700900009", "Crowd Chat");
    const chat = await A.chatOf("447700900009");
    w.pictures["447700900009@c.us"] = "https://pps.whatsapp.net/v/t61/crowd.jpg";
    w.images["https://pps.whatsapp.net/v/t61/crowd.jpg"] = { bytes: JPEG };
    const before = w.asked.length;
    const beforeFetches = w.fetched.length;
    const all = await Promise.all(Array.from({ length: 12 }, () => get(chat.avatar)));
    assert.ok(all.every((r) => r.status === 200 && r.body.equals(JPEG)));
    assert.equal(w.asked.length - before, 1);
    assert.equal(w.fetched.length - beforeFetches, 1);
  });

  await t.test("different chats on one number are asked about one at a time, with a pause between, and never a long queue", async () => {
    setAvatarLimits({ gapMs: 120, queueMax: 5 });
    const chats = [];
    for (let i = 0; i < 8; i++) {
      const phone = `4477009300${String(i).padStart(2, "0")}`;
      await A.hear(phone, `Queue ${i}`);
      const chat = await A.chatOf(phone);
      w.pictures[`${phone}@c.us`] = `https://pps.whatsapp.net/v/t61/q${i}.jpg`;
      w.images[`https://pps.whatsapp.net/v/t61/q${i}.jpg`] = { bytes: JPEG };
      chats.push({ phone, chat });
    }
    const before = w.asked.length;
    const results = await Promise.all(chats.map(({ chat }) => get(chat.avatar)));
    const asked = w.asked.slice(before);
    assert.ok(asked.length <= 6, `no more than the queue allows was asked (${asked.length})`);
    for (let i = 1; i < asked.length; i++) assert.ok(asked[i].at - asked[i - 1].at >= 100, "a pause between questions");
    const served = results.filter((r) => r.status === 200).length;
    assert.ok(served >= 1 && served < 8, `some were told to try later (${served} of 8 served)`);
    // the ones that were turned away are served on a later look, once the queue has gone down
    setAvatarLimits({ gapMs: 0, queueMax: 40 });
    const again = await Promise.all(chats.map(({ chat }) => get(chat.avatar)));
    assert.ok(again.every((r) => r.status === 200));
  });

  await t.test("a contact's own picture works the same way, and a group's too", async () => {
    const contact = (await request(app).get("/api/contacts").set(A.auth)).body.contacts.find((c) => c.phone === "447700900009");
    assert.match(contact.avatar, /^\/api\/avatars\/contact\/[\w-]+\?s=[0-9a-f]{32}$/);
    const res = await get(contact.avatar);
    assert.equal(res.status, 200, "the contact's picture is the same one, kept under the same chat");
    assert.equal(w.asked.filter((a) => a.chatId === "447700900009@c.us").length, 1, "and it was not asked for twice");
    await A.hear("120363012345678901", "Team Group", "@g.us");
    const group = (await A.chats()).find((c) => c.providerChatId === "120363012345678901@g.us");
    assert.ok(group, "the group chat exists");
    w.pictures["120363012345678901@g.us"] = "https://pps.whatsapp.net/v/t61/group.jpg";
    w.images["https://pps.whatsapp.net/v/t61/group.jpg"] = { bytes: PNG, type: "image/png" };
    assert.equal((await get(group.avatar)).status, 200);
  });

  await t.test("deleting a company deletes its pictures", async () => {
    const n = (await query("SELECT count(*)::int AS n FROM profile_pictures WHERE tenant_id=$1", [B.tenantId])).rows[0].n;
    assert.ok(n > 0);
    await query("DELETE FROM tenants WHERE id=$1", [B.tenantId]);
    assert.equal((await query("SELECT count(*)::int AS n FROM profile_pictures WHERE tenant_id=$1", [B.tenantId])).rows[0].n, 0);
  });
});
