import test from "node:test";
import assert from "node:assert/strict";
import { io as serverIo } from "../src/server.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { emitForSession, forgetSessionOwner } from "../src/services/realtime.js";

test("a number's live events reach the browser in the order they were sent", async (t) => {
  t.after(() => serverIo.close());
  const o = await registerTenantAndUser({ name: "Owner", email: "order@test.invalid", password: "Password@123", companyName: "Order Co" });
  const tenantId = o.tenant.id;
  await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id) VALUES(gen_random_uuid()::text,$1,'line-1',$2)", [tenantId, o.user.id]);

  let swapped = 0;
  for (let i = 0; i < 60; i++) {
    // a cold owner lookup is the slow path, and two of them can finish in either order
    forgetSessionOwner(tenantId, "line-1");
    const seen = [];
    const io = {
      to() {
        const target = { to: () => target, emit: (event, payload) => seen.push(payload.phase) };
        return target;
      },
    };
    emitForSession(io, tenantId, "line-1", "sync:progress", { phase: "chats" });
    emitForSession(io, tenantId, "line-1", "sync:progress", { phase: "failed" });
    while (seen.length < 2) await new Promise((r) => setTimeout(r, 2));
    if (seen.join() !== "chats,failed") swapped++;
  }
  assert.equal(swapped, 0);
});

test("a number with no owner on record still gets its events, in order", async (t) => {
  t.after(() => serverIo.close());
  const seen = [];
  const io = { to: () => ({ to: () => io.to(), emit: (event, payload) => seen.push(payload.n) }) };
  // an unknown number has no owner row: the event still goes to the managers
  emitForSession(io, "tenant_missing", "ghost", "sync:progress", { n: 1 });
  emitForSession(io, "tenant_missing", "ghost", "sync:progress", { n: 2 });
  while (seen.length < 2) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(seen, [1, 2]);
});
