import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { ENV } from "../src/config/env.js";
import { query } from "../src/db/index.js";
import { registerTenantAndUser } from "../src/services/authService.js";
import { sendTextMessage } from "../src/services/messageService.js";
import {
  initMessageQueue,
  publishOutbox,
  queueHealth,
  closeQueue,
} from "../src/services/queue/messageQueue.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await pause(150);
  }
  throw new Error("Local queue did not recover within 15 seconds");
}
test(
  "Real Redis/BullMQ replays durable outbox after a Redis restart without duplicate sends",
  { timeout: 45000 },
  async () => {
    const listener = net.createServer();
    await new Promise((r) => listener.listen(0, "127.0.0.1", r));
    const port = listener.address().port;
    await new Promise((r) => listener.close(r));
    let child;
    async function startRedis() {
      child = spawn(
        "redis-server",
        [
          "--port",
          String(port),
          "--bind",
          "127.0.0.1",
          "--save",
          "",
          "--appendonly",
          "no",
        ],
        { stdio: "ignore" },
      );
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    }
    async function stopRedis() {
      const current = child;
      if (!current || current.exitCode !== null) return;
      const done = new Promise((r) => current.once("exit", r));
      current.kill("SIGTERM");
      await done;
    }
    const original = provider.sendTextMessage,
      session = provider.getSession;
    const { tenant } = await registerTenantAndUser({
      name: "Queue Owner",
      email: "queue@test.invalid",
      password: "Password12345",
      companyName: "Queue Test",
    });
    await query(
      "INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,phone,contact_name) VALUES('queue-conversation',$1,'primary','15550000001@c.us','15550000001','Recipient')",
      [tenant.id],
    );
    let calls = 0;
    provider.getSession = () => ({ client: {} });
    provider.sendTextMessage = async () => ({
      providerMessageId: "queue-provider-" + ++calls,
      ack: 2,
    });
    ENV.REDIS_URL = "redis://127.0.0.1:" + port;
    try {
      const first = await sendTextMessage({
        tenantId: tenant.id,
        conversationId: "queue-conversation",
        text: "First",
        idempotencyKey: "first",
      });
      await startRedis();
      await initMessageQueue();
      await until(() => queueHealth().connected);
      await publishOutbox();
      await until(
        async () =>
          (
            await query("SELECT ack FROM messages WHERE id=$1", [
              first.message.id,
            ])
          ).rows[0].ack === 2,
      );
      await stopRedis();
      await until(() => !queueHealth().connected);
      const second = await sendTextMessage({
        tenantId: tenant.id,
        conversationId: "queue-conversation",
        text: "Second",
        idempotencyKey: "second",
      });
      await publishOutbox();
      assert.equal(
        (
          await query(
            "SELECT status FROM outbox_events WHERE aggregate_id=$1",
            [second.message.id],
          )
        ).rows[0].status,
        "pending",
      );
      await startRedis();
      await until(() => queueHealth().connected);
      await publishOutbox();
      await until(
        async () =>
          (
            await query("SELECT ack FROM messages WHERE id=$1", [
              second.message.id,
            ])
          ).rows[0].ack === 2,
      );
      await publishOutbox();
      assert.equal(calls, 2);
    } finally {
      provider.sendTextMessage = original;
      provider.getSession = session;
      await closeQueue(true);
      await stopRedis();
    }
  },
);
