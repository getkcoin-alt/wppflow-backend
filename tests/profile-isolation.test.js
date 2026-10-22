import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import wppconnect from "@wppconnect-team/wppconnect";
import { defaultOptions } from "@wppconnect-team/wppconnect/dist/config/create-config.js";
import { WhatsAppProvider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { ENV } from "../src/config/env.js";

// WPPConnect merges `{ ...defaultOptions, ...options }` and, when no userDataDir was given, writes the
// profile folder into the shared `defaultOptions.puppeteerOptions` object. This stand-in for create()
// reproduces exactly that, so a session that does not bring its own puppeteerOptions leaks its folder
// to the next one.
function standInCreate(launched) {
  return async (options) => {
    const merged = { ...defaultOptions, ...options };
    if (!merged.puppeteerOptions.userDataDir)
      merged.puppeteerOptions.userDataDir = path.resolve(
        process.cwd(),
        merged.folderNameToken,
        options.session,
      );
    launched.push(merged.puppeteerOptions.userDataDir);
    return { getWid: async () => "5511999999999@c.us", close: async () => {} };
  };
}

test("every number opens its own browser profile, not the first one's", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-"));
  const original = Object.getOwnPropertyDescriptor(wppconnect, "create");
  const tokenDir = ENV.TOKEN_DIR;
  const leaked = defaultOptions.puppeteerOptions.userDataDir;
  const launched = [];
  ENV.TOKEN_DIR = root;
  Object.defineProperty(wppconnect, "create", {
    value: standInCreate(launched),
    configurable: true,
    enumerable: true,
    writable: true,
  });
  t.after(() => {
    Object.defineProperty(wppconnect, "create", original);
    ENV.TOKEN_DIR = tokenDir;
    if (leaked === undefined) delete defaultOptions.puppeteerOptions.userDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const provider = new WhatsAppProvider();
  await provider.startSession("tenant-a", "staff-1");
  await provider.startSession("tenant-a", "staff-2");
  await provider.startSession("tenant-b", "staff-1");

  assert.deepEqual(launched, [
    provider.profileDir("tenant-a", "staff-1"),
    provider.profileDir("tenant-a", "staff-2"),
    provider.profileDir("tenant-b", "staff-1"),
  ]);
  assert.equal(new Set(launched).size, 3, "three numbers, three profiles");
  assert.equal(
    defaultOptions.puppeteerOptions.userDataDir,
    undefined,
    "WPPConnect's shared defaults are never written to",
  );
  for (const dir of launched)
    assert.ok(path.resolve(dir).startsWith(path.resolve(root) + path.sep), dir);
});
