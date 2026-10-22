import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { setMediaSend } from "../src/services/mediaService.js";
import { closeSessions } from "../src/services/sessionService.js";

const KEYS = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT", "S3_REGION"];

test("Media storage check proves the bucket works before anyone relies on it", async (t) => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const objects = new Map();
  let failWith = null;
  // An in-memory bucket: the commands are the real AWS commands, only the network is replaced.
  setMediaSend(async (command) => {
    if (failWith) throw failWith;
    const { Key, Body } = command.input;
    const kind = command.constructor.name;
    if (kind === "PutObjectCommand") return void objects.set(Key, Buffer.from(Body));
    if (kind === "GetObjectCommand") {
      if (!objects.has(Key)) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { Body: { destroy() {} }, ContentLength: objects.get(Key).length };
    }
    if (kind === "HeadObjectCommand") {
      if (!objects.has(Key)) throw Object.assign(new Error("missing"), { name: "NotFound" });
      return { ContentLength: objects.get(Key).length };
    }
    if (kind === "DeleteObjectCommand") return void objects.delete(Key);
    throw new Error(`unexpected ${kind}`);
  });
  t.after(async () => {
    setMediaSend(undefined);
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    await closeSessions(io);
    io.close();
  });

  const o = await registerTenantAndUser({ name: "Olivia", email: "olivia@media.test", password: "Password@123", companyName: "Media Co" });
  const tenantId = o.tenant.id;
  const agent = (await query("INSERT INTO users(name,email,password_hash) VALUES('Sam','sam@media.test','x') RETURNING *")).rows[0];
  await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'agent')", [tenantId, agent.id]);
  const owner = { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` };
  const staff = { Authorization: `Bearer ${generateAccessToken(agent, tenantId, "agent")}` };
  const configure = () => {
    process.env.S3_BUCKET = "scriwo-media";
    process.env.S3_ACCESS_KEY_ID = "test-key";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret";
    process.env.S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.S3_REGION = "auto";
  };

  await t.test("without settings it says exactly which ones are missing", async () => {
    for (const k of KEYS) delete process.env[k];
    const res = await request(app).get("/api/workspace/media-check").set(owner);
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, false);
    assert.deepEqual(res.body.missing, ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    const health = await request(app).get("/health");
    assert.equal(health.body.media.configured, false);
    assert.equal((await request(app).post("/api/workspace/media-check/upload").set(owner)).status, 503);
  });

  await t.test("with working storage it writes, reads back and deletes a test file", async () => {
    configure();
    const res = await request(app).get("/api/workspace/media-check").set(owner);
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.equal(objects.size, 0, "the test file is cleaned up");
    assert.equal((await request(app).get("/health")).body.media.configured, true);
  });

  await t.test("refused keys, a missing bucket and an unreachable endpoint each get an actionable message", async () => {
    failWith = Object.assign(new Error("denied"), { name: "AccessDenied" });
    assert.match((await request(app).get("/api/workspace/media-check").set(owner)).body.error, /keys were refused/);
    failWith = Object.assign(new Error("nope"), { name: "NoSuchBucket" });
    assert.match((await request(app).get("/api/workspace/media-check").set(owner)).body.error, /bucket was not found/);
    failWith = Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" });
    assert.match((await request(app).get("/api/workspace/media-check").set(owner)).body.error, /S3_ENDPOINT/);
    failWith = null;
  });

  await t.test("the browser upload test hands out a signed address inside the company's own folder", async () => {
    const res = await request(app).post("/api/workspace/media-check/upload").set(owner);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.key.startsWith(`${tenantId}/_check/`));
    assert.match(res.body.url, /^https:\/\/.*scriwo-media.*X-Amz-Signature=/);
    assert.equal(res.body.bytes, 5);

    // The browser's upload is simulated by writing the object the way the signed address would.
    objects.set(res.body.key, Buffer.from("check"));
    const done = await request(app).post("/api/workspace/media-check/finish").set(owner).send({ key: res.body.key });
    assert.deepEqual(done.body, { status: "success", ok: true });
    assert.equal(objects.size, 0, "deleted after the check");

    const never = await request(app).post("/api/workspace/media-check/finish").set(owner).send({ key: `${tenantId}/_check/never-uploaded` });
    assert.equal(never.body.ok, false);
    assert.match(never.body.error, /did not reach storage/);
  });

  await t.test("a check can never touch another company's files, and staff cannot run it", async () => {
    const other = await request(app).post("/api/workspace/media-check/finish").set(owner).send({ key: "someone-else/_check/x" });
    assert.equal(other.status, 400);
    for (const [method, path] of [["get", "/api/workspace/media-check"], ["post", "/api/workspace/media-check/upload"], ["post", "/api/workspace/media-check/finish"]])
      assert.equal((await request(app)[method](path).set(staff).send({ key: `${tenantId}/_check/x` })).status, 403, path);
  });
});
