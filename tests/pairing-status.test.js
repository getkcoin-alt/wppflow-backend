import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import wppconnect from "@wppconnect-team/wppconnect";
import { WhatsAppProvider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { ENV } from "../src/config/env.js";

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
};

// create() stand-in: reports what WPPConnect reported for a fresh profile (inChat BEFORE notLogged
// and the QR code), waits for the "scan", then returns the client.
function standIn({ events, scan }) {
  return async (options) => {
    for (const step of events) {
      if (step === "qr") options.catchQR("base64", "ascii", 1, "code");
      else options.statusFind(step, options.session);
    }
    await scan.promise;
    options.statusFind("qrReadSuccess", options.session);
    return { getWid: async () => "971501234567@c.us", close: async () => {}, onAnyMessage() {}, onAck() {} };
  };
}

test("a number is connected when its login completes, not when WhatsApp first says inChat", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-"));
  const original = Object.getOwnPropertyDescriptor(wppconnect, "create");
  const tokenDir = ENV.TOKEN_DIR;
  ENV.TOKEN_DIR = root;
  let release;
  const scan = { promise: new Promise((r) => (release = r)) };
  Object.defineProperty(wppconnect, "create", {
    value: standIn({ events: ["disconnectedMobile", "inChat", "notLogged", "qr"], scan }),
    configurable: true,
    enumerable: true,
    writable: true,
  });
  t.after(() => {
    Object.defineProperty(wppconnect, "create", original);
    ENV.TOKEN_DIR = tokenDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const provider = new WhatsAppProvider();
  const reported = [];
  const started = provider.startSession("tenant-a", "testing", { onStatus: (s) => reported.push(s) });

  await until(() => reported.includes("QRCODE"));
  assert.ok(!reported.includes("CONNECTED"), `reported before anyone scanned: ${reported.join(", ")}`);
  assert.equal(provider.getSession("tenant-a", "testing").status, "QRCODE");

  release();
  await started;
  assert.equal(reported.at(-1), "CONNECTED");
  const session = provider.getSession("tenant-a", "testing");
  assert.equal(session.status, "CONNECTED");
  assert.equal(session.phone, "971501234567@c.us", "the phone is known when it is reported connected");
});

test("a number that is already logged in connects as soon as it has started", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-"));
  const original = Object.getOwnPropertyDescriptor(wppconnect, "create");
  const tokenDir = ENV.TOKEN_DIR;
  ENV.TOKEN_DIR = root;
  Object.defineProperty(wppconnect, "create", {
    value: standIn({ events: ["isLogged", "inChat"], scan: { promise: Promise.resolve() } }),
    configurable: true,
    enumerable: true,
    writable: true,
  });
  t.after(() => {
    Object.defineProperty(wppconnect, "create", original);
    ENV.TOKEN_DIR = tokenDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const provider = new WhatsAppProvider();
  const reported = [];
  await provider.startSession("tenant-a", "staff-9", { onStatus: (s) => reported.push(s) });
  assert.ok(reported.includes("CONNECTED"));
  assert.equal(provider.getSession("tenant-a", "staff-9").phone, "971501234567@c.us");
});
