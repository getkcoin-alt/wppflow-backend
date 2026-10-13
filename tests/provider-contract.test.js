import test from "node:test";
import assert from "node:assert/strict";
import { WhatsAppProvider } from "../src/services/whatsapp/WhatsAppProvider.js";
test("Provider normalizes real WPPConnect timestamps, recipients, voice notes and pending ACKs", () => {
  const p = new WhatsAppProvider();
  const outgoing = p.normalizeMessage({
    id: { _serialized: "provider-id" },
    fromMe: true,
    from: "self@c.us",
    to: "123456789@lid",
    timestamp: 1700000000,
    type: "ptt",
  });
  assert.equal(outgoing.remoteId, "123456789@lid");
  assert.equal(outgoing.timestampEpoch, 1700000000);
  assert.equal(outgoing.type, "audio");
  assert.equal(p.normalizeAck({ id: "id", ack: 0 }).ack, 0);
});
test("Provider sends once using supported client API and keeps exact LID identity", async () => {
  const p = new WhatsAppProvider();
  let calls = 0,
    target;
  p.sessions.set(p.sessionKey("tenant", "primary"), {
    client: {
      sendText: async (to) => {
        calls++;
        target = to;
        return { id: "confirmed", ack: 1 };
      },
    },
  });
  const result = await p.sendTextMessage(
    "tenant",
    "primary",
    "123456789@lid",
    "Hi",
  );
  assert.equal(calls, 1);
  assert.equal(target, "123456789@lid");
  assert.equal(result.providerMessageId, "confirmed");
  p.getSession("tenant", "primary").client.sendText = async () => {
    calls++;
    throw new Error("Transport lost");
  };
  await assert.rejects(
    p.sendTextMessage("tenant", "primary", "123456789@lid", "Hi"),
    (e) => e.code === "DELIVERY_UNCERTAIN",
  );
  assert.equal(calls, 2);
});
