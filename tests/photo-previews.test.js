import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import request from "supertest";
import sharp from "sharp";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { handleIncomingMessage } from "../src/services/messageService.js";
import { setMediaSend, verifyUpload } from "../src/services/mediaService.js";
import { makeThumbnail, THUMBNAIL_EDGE } from "../src/services/thumbnailService.js";
import { closeSessions } from "../src/services/sessionService.js";

const KEYS = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT", "S3_REGION"];
const photo = (width, height, extra = {}) =>
  sharp({ create: { width, height, channels: 3, background: "#c0392b" } })
    .jpeg(extra)
    .toBuffer();
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("condition not reached");
};

test("Photos get a small preview that the chat shows instead of the full file", async (t) => {
  await t.test("a preview keeps the proportions, is small, and never enlarges", async () => {
    const wide = await makeThumbnail(await photo(3000, 1500), "image/jpeg");
    assert.equal(wide.mime, "image/webp");
    assert.deepEqual([wide.width, wide.height], [3000, 1500], "reports the photo's own size");
    const meta = await sharp(wide.buffer).metadata();
    assert.equal(meta.format, "webp");
    assert.deepEqual([meta.width, meta.height], [THUMBNAIL_EDGE, THUMBNAIL_EDGE / 2]);
    assert.ok(wide.buffer.length < 20 * 1024);

    const small = await makeThumbnail(await photo(100, 50), "image/jpeg");
    const smallMeta = await sharp(small.buffer).metadata();
    assert.deepEqual([smallMeta.width, smallMeta.height], [100, 50]);
  });

  await t.test("a photo taken sideways is shown upright, and its size reflects that", async () => {
    // Stored 1200 x 600, with the camera's "rotate 90°" flag: people see it 600 x 1200.
    const sideways = await sharp(await photo(1200, 600)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const made = await makeThumbnail(sideways, "image/jpeg");
    assert.deepEqual([made.width, made.height], [600, 1200]);
    const meta = await sharp(made.buffer).metadata();
    assert.deepEqual([meta.width, meta.height], [240, 480]);
  });

  await t.test("files that aren't photos, or can't be read, simply have no preview", async () => {
    assert.equal(await makeThumbnail(Buffer.from("%PDF-1.4"), "application/pdf"), null);
    assert.equal(await makeThumbnail(Buffer.from("not an image at all"), "image/jpeg"), null);
    assert.equal(await makeThumbnail(Buffer.alloc(0), "image/png"), null);
  });
});

test("Previews are made for received photos, uploads and old photos", async (t) => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const bucket = new Map();
  setMediaSend(async (command) => {
    const { Key, Body } = command.input;
    const kind = command.constructor.name;
    if (kind === "PutObjectCommand") return void bucket.set(Key, Buffer.from(Body));
    if (kind === "GetObjectCommand")
      return { Body: Readable.from([bucket.get(Key)]), ContentLength: bucket.get(Key)?.length };
    if (kind === "HeadObjectCommand")
      return { ContentLength: bucket.get(Key)?.length, ContentType: "image/jpeg" };
    if (kind === "DeleteObjectCommand") return void bucket.delete(Key);
    throw new Error(`unexpected ${kind}`);
  });
  process.env.S3_BUCKET = "scriwo-media";
  process.env.S3_ACCESS_KEY_ID = "k";
  process.env.S3_SECRET_ACCESS_KEY = "s";
  process.env.S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.S3_REGION = "auto";
  t.after(async () => {
    setMediaSend(undefined);
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    await closeSessions(io);
    io.close();
  });

  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@previews.test", password: "Password@123", companyName: "Previews Co" });
  const tenantId = o.tenant.id;
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id) VALUES(gen_random_uuid()::text,$1,'line-olivia',$2)", [tenantId, o.user.id]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  let epoch = 1700000000;
  const receive = (remote, rawType, extra = {}) =>
    handleIncomingMessage({
      tenantId,
      sessionName: "line-olivia",
      msg: { providerMessageId: `true_${remote}_${++epoch}`, fromMe: false, remoteId: remote, rawType, type: rawType, text: "📷", timestampEpoch: epoch, senderName: "Customer", ack: 2, ...extra },
    });
  const conversationId = async (remote) =>
    (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND provider_chat_id=$2", [tenantId, remote])).rows[0].id;
  const list = async (chat) => (await request(app).get(`/api/conversations/${chat}/messages`).set(owner)).body;

  const REMOTE = "919000000001@c.us";
  const jpeg = await photo(1600, 900);
  await receive(REMOTE, "image", { mimeType: "image/jpeg", byteSize: jpeg.length, downloadMedia: async () => jpeg });
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
  await receive(REMOTE, "document", { mimeType: "application/pdf", byteSize: pdf.length, fileName: "Quote.pdf", text: "📄 Document", downloadMedia: async () => pdf });
  const chat = await conversationId(REMOTE);

  await t.test("a received photo is saved with a preview and its real size", async () => {
    const row = (await query("SELECT * FROM attachments WHERE tenant_id=$1 AND mime_type='image/jpeg'", [tenantId])).rows[0];
    assert.equal(row.thumb_key, `${row.storage_key}.preview`);
    assert.deepEqual([row.width, row.height], [1600, 900]);
    assert.ok(bucket.has(row.thumb_key) && bucket.has(row.storage_key));
    assert.ok(bucket.get(row.thumb_key).length < jpeg.length);
  });

  await t.test("the chat gets the preview address, the full address and the size for each photo", async () => {
    const body = await list(chat);
    const image = body.messages.find((m) => m.type === "image");
    assert.match(image.thumbUrl, /X-Amz-Signature=/);
    assert.match(image.thumbUrl, /\.preview/);
    assert.notEqual(image.thumbUrl, image.mediaUrl);
    assert.deepEqual([image.width, image.height], [1600, 900]);
    assert.equal(body.previewsPending, undefined);
    const doc = body.messages.find((m) => m.type === "document");
    assert.equal(doc.thumbUrl, undefined, "only photos have previews");
    assert.equal(doc.width, undefined);
  });

  await t.test("addresses are stable for a while, so the browser can keep what it already showed", async () => {
    const [a, b] = [await list(chat), await list(chat)];
    const url = (body) => body.messages.find((m) => m.type === "image").thumbUrl;
    assert.equal(url(a), url(b));
    assert.match(url(a), /X-Amz-Expires=5400/);
  });

  await t.test("photos saved before previews existed get one in the background", async () => {
    const old = await photo(800, 1200);
    const stale = await receive("919000000002@c.us", "image", { mimeType: "image/jpeg", byteSize: old.length, downloadMedia: async () => old });
    assert.ok(stale);
    const oldChat = await conversationId("919000000002@c.us");
    // Make it look like one saved before this feature: no preview recorded.
    await query("UPDATE attachments SET thumb_key=NULL,width=NULL,height=NULL WHERE conversation_id=$1", [oldChat]);
    const first = await list(oldChat);
    assert.equal(first.previewsPending, 1);
    assert.equal(first.messages[0].thumbUrl, undefined, "the chat opens at once with the full photo");
    const row = await until(async () => {
      const r = (await query("SELECT * FROM attachments WHERE conversation_id=$1", [oldChat])).rows[0];
      return r.thumb_key ? r : null;
    });
    assert.deepEqual([row.width, row.height], [800, 1200]);
    const second = await list(oldChat);
    assert.equal(second.previewsPending, undefined);
    assert.match(second.messages[0].thumbUrl, /X-Amz-Signature=/);
  });

  await t.test("a photo that can't be read is marked so it isn't retried on every refresh", async () => {
    const broken = await receive("919000000003@c.us", "image", { mimeType: "image/png", byteSize: 8, downloadMedia: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    assert.ok(broken);
    const brokenChat = await conversationId("919000000003@c.us");
    const row = (await query("SELECT * FROM attachments WHERE conversation_id=$1", [brokenChat])).rows[0];
    assert.equal(row.thumb_key, "", "recorded as having no preview");
    const body = await list(brokenChat);
    assert.equal(body.previewsPending, undefined);
    assert.equal(body.messages[0].thumbUrl, undefined);
    assert.ok(body.messages[0].mediaUrl, "the photo itself still opens");
  });

  await t.test("a photo uploaded from the browser is checked once and gets its preview before it is sent", async () => {
    const upload = await photo(1000, 500);
    const prepared = await request(app)
      .post("/api/attachments/prepare")
      .set(owner)
      .send({ conversationId: chat, mimeType: "image/jpeg", byteSize: upload.length, filename: "site.jpg" });
    assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
    const row = (await query("SELECT * FROM attachments WHERE id=$1", [prepared.body.attachmentId])).rows[0];
    bucket.set(row.storage_key, upload); // what the browser's direct upload to storage does
    const buffer = await verifyUpload(row);
    assert.ok(buffer.equals(upload), "the verified file is handed back, not read twice");

    const sent = await request(app)
      .post(`/api/attachments/${row.id}/send`)
      .set(owner)
      .send({ idempotencyKey: crypto.randomUUID(), caption: "Site photo" });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const after = (await query("SELECT * FROM attachments WHERE id=$1", [row.id])).rows[0];
    assert.equal(after.upload_status, "ready");
    assert.equal(after.thumb_key, `${row.storage_key}.preview`);
    assert.deepEqual([after.width, after.height], [1000, 500]);
    assert.ok(bucket.has(after.thumb_key));
  });
});
