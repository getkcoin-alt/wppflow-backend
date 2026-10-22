import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { setMediaSend, validateMedia, validateContent, limitFor } from "../src/services/mediaService.js";
import { closeSessions } from "../src/services/sessionService.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";

const KEYS = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT", "S3_REGION"];
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const MB = 1024 * 1024;

test("Files that were never saved can be loaded from WhatsApp when someone opens them", async (t) => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const bucket = new Map();
  setMediaSend(async (command) => {
    const { Key, Body } = command.input;
    const kind = command.constructor.name;
    if (kind === "PutObjectCommand") return void bucket.set(Key, Buffer.from(Body));
    if (kind === "GetObjectCommand") return { Body: { destroy() {} }, ContentLength: bucket.get(Key)?.length };
    if (kind === "HeadObjectCommand") return { ContentLength: bucket.get(Key)?.length };
    if (kind === "DeleteObjectCommand") return void bucket.delete(Key);
    throw new Error(`unexpected ${kind}`);
  });
  const original = { getSession: provider.getSession };
  t.after(async () => {
    setMediaSend(undefined);
    Object.assign(provider, original);
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    await closeSessions(io);
    io.close();
  });
  const storageOn = () => {
    process.env.S3_BUCKET = "scriwo-media";
    process.env.S3_ACCESS_KEY_ID = "k";
    process.env.S3_SECRET_ACCESS_KEY = "s";
    process.env.S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.S3_REGION = "auto";
  };

  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@fetch.test", password: "Password@123", companyName: "Fetch Co" });
  const tenantId = o.tenant.id;
  const mkUser = async (name) => (await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,'x') RETURNING *", [name, `${name.toLowerCase()}@fetch.test`])).rows[0];
  const sam = await mkUser("Sam"), tina = await mkUser("Tina");
  for (const u of [sam, tina]) await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, u.id]);
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id) VALUES(gen_random_uuid()::text,$1,'line-sam',$2),(gen_random_uuid()::text,$1,'line-tina',$3)", [tenantId, sam.id, tina.id]);
  const auth = (u, role) => ({ Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` });
  const owner = auth(o.user, "owner"), samAuth = auth(sam, "agent"), tinaAuth = auth(tina, "agent");

  let epoch = 1700000000;
  const post = (session, remote, rawType, extra = {}) =>
    handleIncomingMessage({
      tenantId,
      sessionName: session,
      history: true,
      msg: { providerMessageId: `true_${remote}_${++epoch}`, fromMe: false, remoteId: remote, rawType, type: rawType === "chat" ? "text" : rawType, text: rawType === "chat" ? "hello" : "📷", timestampEpoch: epoch, senderName: "Customer", ack: 2, ...extra },
    });
  await post("line-sam", "919000000001@c.us", "image");
  await post("line-sam", "919000000001@c.us", "document", { text: "📄 Document" });
  await post("line-sam", "919000000001@c.us", "image");
  await post("line-sam", "919000000001@c.us", "chat");
  await post("line-tina", "919000000002@c.us", "image");
  const conv = async (chat) => (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND provider_chat_id=$2", [tenantId, chat])).rows[0].id;
  const samChat = await conv("919000000001@c.us"), tinaChat = await conv("919000000002@c.us");
  const messagesOf = async (chat, who = owner) => (await request(app).get(`/api/conversations/${chat}/messages`).set(who)).body;
  const mediaMsgs = async (chat) => (await messagesOf(chat)).messages.filter((m) => m.type !== "text");

  // A WhatsApp number whose files we can serve, with counters so we can see what was downloaded.
  const calls = { decrypt: 0, download: 0 };
  const files = new Map();
  const client = {
    getMessageById: async (id) => files.get(id) ?? null,
    getMessages: async () => [...files.values()],
    decryptFile: async (raw) => {
      calls.decrypt++;
      if (raw.expired) throw new Error("Error trying to download the file.");
      return raw.buffer;
    },
    downloadMedia: async (raw) => {
      calls.download++;
      if (raw.noFallback) throw new Error("gone");
      return `data:${raw.mimetype};base64,${raw.buffer.toString("base64")}`;
    },
  };
  provider.getSession = () => ({ client });
  const serve = (m, raw) => files.set(m.providerMessageId, { id: { _serialized: m.providerMessageId }, mediaKey: "k", clientUrl: "https://mmg.whatsapp.net/x", ...raw });
  const fetchOne = (chat, message, who = owner) => request(app).post(`/api/conversations/${chat}/messages/${message.id}/media`).set(who);

  await t.test("with storage off the chat says so, and loading is refused with a clear reason", async () => {
    for (const k of KEYS) delete process.env[k];
    const list = await messagesOf(samChat);
    assert.deepEqual(list.messages.filter((m) => m.type !== "text").map((m) => m.mediaState), ["storage_off", "storage_off", "storage_off"]);
    assert.equal(list.mediaPending, undefined);
    const [first] = await mediaMsgs(samChat);
    const res = await fetchOne(samChat, first);
    assert.equal(res.status, 503);
    assert.match(res.body.message, /isn't set up/);
  });

  await t.test("unsaved files are listed as such, with how many are waiting", async () => {
    storageOn();
    const list = await messagesOf(samChat);
    assert.equal(list.mediaPending, 3);
    assert.ok(list.messages.filter((m) => m.type !== "text").every((m) => m.mediaState === "not_saved" && !m.mediaUrl));
    assert.equal(list.messages.find((m) => m.type === "text").mediaState, undefined);
  });

  await t.test("opening a photo downloads it once, keeps it, and gives a viewable address", async () => {
    const [photo] = await mediaMsgs(samChat);
    serve(photo, { mimetype: "image/jpeg", size: JPEG.length, filename: "", buffer: JPEG });
    const res = await fetchOne(samChat, photo);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.message.mediaState, "ready");
    assert.equal(res.body.message.mimeType, "image/jpeg");
    assert.match(res.body.message.mediaUrl, /X-Amz-Signature=/);
    assert.match(res.body.message.openUrl, /response-content-disposition=inline/i);
    assert.equal(bucket.size, 1);
    assert.equal(calls.decrypt, 1);
    const again = await fetchOne(samChat, photo);
    assert.equal(again.status, 200);
    assert.equal(calls.decrypt, 1, "already saved: nothing is downloaded twice");
    assert.equal((await messagesOf(samChat)).mediaPending, 2);
    assert.equal((await mediaMsgs(samChat)).find((m) => m.id === photo.id).mediaState, "ready");
  });

  await t.test("a PDF opens inside the browser and also downloads; two people at once share one download", async () => {
    const doc = (await mediaMsgs(samChat)).find((m) => m.type === "document");
    serve(doc, { mimetype: "application/pdf", size: PDF.length, filename: "Quote 12.pdf", buffer: PDF });
    const before = calls.decrypt;
    const [a, b] = await Promise.all([fetchOne(samChat, doc), fetchOne(samChat, doc, samAuth)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(calls.decrypt - before, 1, "one download for both");
    assert.equal(a.body.message.fileName, "Quote 12.pdf");
    assert.match(a.body.message.openUrl, /response-content-disposition=inline/i);
    assert.match(a.body.message.mediaUrl, /response-content-disposition=attachment/i);
  });

  await t.test("every way a file can be unavailable gets its own plain explanation", async () => {
    const [, , lastPhoto] = (await mediaMsgs(samChat)).concat([]).sort((x, y) => x.timestampEpoch - y.timestampEpoch);
    const target = (await mediaMsgs(samChat)).find((m) => m.type === "image" && m.mediaState === "not_saved");
    assert.ok(target && lastPhoto);

    // WhatsApp no longer knows the message
    files.delete(target.providerMessageId);
    let res = await fetchOne(samChat, target);
    assert.equal(res.status, 404);
    assert.match(res.body.message, /no longer has this file/);

    // the direct link expired but WhatsApp Web's own downloader still works
    serve(target, { mimetype: "image/jpeg", size: JPEG.length, buffer: JPEG, expired: true });
    const d0 = calls.download;
    assert.equal((await fetchOne(samChat, target)).status, 200);
    assert.equal(calls.download - d0, 1);

    // neither works any more
    const other = (await mediaMsgs(tinaChat))[0];
    serve(other, { mimetype: "image/jpeg", size: JPEG.length, buffer: JPEG, expired: true, noFallback: true });
    res = await fetchOne(tinaChat, other);
    assert.equal(res.status, 404);
    assert.match(res.body.message, /no longer has this file/);

    // too big: refused before anything is downloaded
    serve(other, { mimetype: "image/jpeg", size: 17 * MB, buffer: JPEG });
    const before = calls.decrypt;
    res = await fetchOne(tinaChat, other);
    assert.equal(res.status, 413);
    assert.match(res.body.message, /over 16 MB/);
    assert.equal(calls.decrypt, before);

    // a kind of file we do not store
    serve(other, { mimetype: "application/x-msdownload", size: 100, buffer: Buffer.from("MZ") });
    res = await fetchOne(tinaChat, other);
    assert.equal(res.status, 415);

    // contents that do not match the type they claim
    serve(other, { mimetype: "image/png", size: 100, buffer: Buffer.from("not a png at all") });
    assert.equal((await fetchOne(tinaChat, other)).status, 400);

    // the number is offline
    provider.getSession = () => null;
    res = await fetchOne(tinaChat, other);
    assert.equal(res.status, 409);
    assert.match(res.body.message, /offline/);
    provider.getSession = () => ({ client });
  });

  await t.test("staff can load files only in chats they can open", async () => {
    const tinaPhoto = (await mediaMsgs(tinaChat))[0];
    assert.equal((await fetchOne(tinaChat, tinaPhoto, samAuth)).status, 404, "Sam cannot touch Tina's chat");
    const text = (await messagesOf(samChat)).messages.find((m) => m.type === "text");
    assert.equal((await fetchOne(samChat, text, samAuth)).status, 400, "a text message has no file");
    assert.equal((await request(app).post(`/api/conversations/${samChat}/messages/not-an-id/media`).set(samAuth)).status, 404);
    assert.equal((await request(app).post(`/api/conversations/${tinaChat}/media/fetch-pending`).set(samAuth).send({})).status, 404);
  });

  await t.test("a whole chat loads in small batches, reporting what could not be loaded", async () => {
    // three more unsaved photos in Sam's chat
    for (let i = 0; i < 3; i++) await post("line-sam", "919000000001@c.us", "image");
    const pending = (await mediaMsgs(samChat)).filter((m) => m.mediaState === "not_saved");
    assert.equal(pending.length, 3);
    pending.forEach((m, i) => serve(m, { mimetype: "image/jpeg", size: JPEG.length, buffer: JPEG, ...(i === 1 ? { expired: true, noFallback: true } : {}) }));

    const first = await request(app).post(`/api/conversations/${samChat}/media/fetch-pending`).set(samAuth).send({ limit: 2 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.saved + first.body.failed.length, 2);
    assert.ok(first.body.nextBefore, "more to do");
    const second = await request(app).post(`/api/conversations/${samChat}/media/fetch-pending`).set(samAuth).send({ limit: 2, before: first.body.nextBefore });
    assert.equal(second.body.saved + second.body.failed.length, 1);
    assert.equal(second.body.nextBefore, null, "finished");
    assert.equal(first.body.saved + second.body.saved, 2);
    assert.equal(first.body.failed.length + second.body.failed.length, 1);
    assert.match([...first.body.failed, ...second.body.failed][0].reason, /no longer has this file/);
    assert.equal(second.body.remaining, 1, "only the expired one is still unsaved");

    provider.getSession = () => null;
    const offline = await request(app).post(`/api/conversations/${samChat}/media/fetch-pending`).set(samAuth).send({});
    assert.match(offline.body.stopped, /offline/);
    assert.equal(offline.body.nextBefore, null);
    provider.getSession = () => ({ client });
  });

  await t.test("the new file types and the 16 MB / 64 MB limits", () => {
    assert.equal(limitFor("image/png"), 16 * MB);
    assert.equal(limitFor("application/pdf"), 64 * MB);
    assert.doesNotThrow(() => validateMedia("image/png", 15 * MB));
    assert.throws(() => validateMedia("image/png", 17 * MB), { status: 413 });
    assert.doesNotThrow(() => validateMedia("application/pdf", 60 * MB));
    assert.throws(() => validateMedia("application/pdf", 65 * MB), { status: 413 });
    for (const bad of ["text/html", "image/svg+xml", "application/x-msdownload", "application/javascript"])
      assert.throws(() => validateMedia(bad, 10), { status: 415 }, bad);
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    assert.doesNotThrow(() => validateContent(Buffer.from("504b030414000600", "hex"), docx));
    assert.doesNotThrow(() => validateContent(Buffer.from("GIF89a"), "image/gif"));
    assert.doesNotThrow(() => validateContent(Buffer.from("#!AMR\n"), "audio/amr"));
    assert.doesNotThrow(() => validateContent(Buffer.from("d0cf11e0a1b11ae1", "hex"), "application/msword"));
    assert.throws(() => validateContent(Buffer.from("<html><script>alert(1)</script>"), "text/csv"));
    assert.throws(() => validateContent(Buffer.from("MZ......"), docx));
  });
});
