import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { closeSessions } from "../src/services/sessionService.js";

test("The production domains can always talk to the backend", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  for (const origin of ["https://scriwo.com", "https://www.scriwo.com"]) {
    await t.test(`${origin}: preflight and requests are allowed, with cookies`, async () => {
      const pre = await request(app)
        .options("/api/auth/login")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "content-type,authorization,x-tenant-id");
      assert.equal(pre.status, 204);
      assert.equal(pre.headers["access-control-allow-origin"], origin);
      assert.equal(pre.headers["access-control-allow-credentials"], "true");
      assert.match(pre.headers["access-control-allow-headers"], /authorization/i);

      const res = await request(app).get("/health").set("Origin", origin);
      assert.equal(res.headers["access-control-allow-origin"], origin);
      assert.equal(res.headers["access-control-allow-credentials"], "true");
    });
  }

  await t.test("an unknown website gets no permission", async () => {
    const res = await request(app).get("/health").set("Origin", "https://evil.example");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });
});
