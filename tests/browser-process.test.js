import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  browsersUsing,
  stopBrowsers,
  clearProfileLocks,
  sweepOrphanBrowsers,
} from "../src/services/whatsapp/browserProcess.js";
import { defaultWhatsAppProvider as provider } from "../src/services/whatsapp/WhatsAppProvider.js";
import { friendlyStartError } from "../src/services/sessionService.js";
import { ENV } from "../src/config/env.js";

const linux = process.platform === "linux";
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not reached");
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("A browser left running can never block the next connection", { skip: !linux && "reads /proc" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browsers-"));
  const children = [];
  // A stand-in for Chromium: any long-running process started with a --user-data-dir flag.
  const fakeBrowser = (profile) => {
    fs.mkdirSync(profile, { recursive: true });
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)", "--", `--user-data-dir=${profile}`], { stdio: "ignore" });
    children.push(child);
    return child;
  };
  t.after(() => {
    for (const c of children) try { process.kill(c.pid, "SIGKILL"); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  await until(() => true);

  await t.test("stops the browser of exactly one profile, never a similarly named one", async () => {
    const one = fakeBrowser(path.join(root, "tenant_a_staff-1", "tenant_a_staff-1"));
    const ten = fakeBrowser(path.join(root, "tenant_a_staff-10", "tenant_a_staff-10"));
    await until(() => browsersUsing(path.join(root, "tenant_a_staff-1", "tenant_a_staff-1")).length === 1);
    const stopped = await stopBrowsers(path.join(root, "tenant_a_staff-1", "tenant_a_staff-1"));
    assert.equal(stopped, 1);
    await until(() => !alive(one.pid));
    assert.ok(alive(ten.pid), "staff-10 keeps running");
    assert.equal(await stopBrowsers(path.join(root, "tenant_a_staff-1", "tenant_a_staff-1")), 0, "nothing left to stop");
  });

  // A stand-in for Chromium that behaves like it does on SIGTERM (finishes writing, then exits), and one that does not listen.
  const polite = (profile, marker) => {
    fs.mkdirSync(profile, { recursive: true });
    const code = `process.on("SIGTERM",()=>{require("fs").writeFileSync(${JSON.stringify(marker)},"finished writing");process.exit(0)});setInterval(()=>{},1e6)`;
    const child = spawn(process.execPath, ["-e", code, "--", `--user-data-dir=${profile}`], { stdio: "ignore" });
    children.push(child);
    return child;
  };
  const deaf = (profile) => {
    fs.mkdirSync(profile, { recursive: true });
    const child = spawn(process.execPath, ["-e", `process.on("SIGTERM",()=>{});setInterval(()=>{},1e6)`, "--", `--user-data-dir=${profile}`], { stdio: "ignore" });
    children.push(child);
    return child;
  };

  await t.test("a browser is asked to quit first, so that it can finish writing its profile (WhatsApp's login is in it), not killed outright", async () => {
    const profile = path.join(root, "gentle", "gentle");
    const marker = path.join(root, "gentle-marker");
    const child = polite(profile, marker);
    await until(() => browsersUsing(profile).length === 1);
    await new Promise((r) => setTimeout(r, 200)); // let it install its handler
    assert.equal(await stopBrowsers(profile), 1);
    await until(() => !alive(child.pid));
    assert.equal(fs.existsSync(marker), true, "it got SIGTERM and finished its write; a SIGKILL would have left no trace");
  });

  await t.test("a browser that ignores the request is forced after the grace period, and no sooner", async () => {
    const saved = ENV.BROWSER_TERM_GRACE_MS;
    ENV.BROWSER_TERM_GRACE_MS = 600;
    try {
      const profile = path.join(root, "stubborn", "stubborn");
      const child = deaf(profile);
      await until(() => browsersUsing(profile).length === 1);
      await new Promise((r) => setTimeout(r, 200));
      const began = Date.now();
      assert.equal(await stopBrowsers(profile), 1);
      const took = Date.now() - began;
      await until(() => !alive(child.pid));
      assert.ok(took >= 550, `it was given its grace period first (${took} ms)`);
      assert.ok(took < 3000, `and forced soon after (${took} ms)`);
    } finally {
      ENV.BROWSER_TERM_GRACE_MS = saved;
    }
  });

  await t.test("clears the lock files a killed browser leaves behind", () => {
    const profile = path.join(root, "locked");
    fs.mkdirSync(profile, { recursive: true });
    fs.symlinkSync("somewhere-gone-123", path.join(profile, "SingletonLock"));
    fs.symlinkSync("/tmp/gone/SingletonSocket", path.join(profile, "SingletonSocket"));
    fs.writeFileSync(path.join(profile, "Cookies"), "keep");
    clearProfileLocks(profile);
    assert.equal(fs.readdirSync(profile).join(","), "Cookies");
  });

  await t.test("closing a number that is still pairing stops its browser (there is no client yet)", async () => {
    const saved = ENV.TOKEN_DIR;
    ENV.TOKEN_DIR = root;
    try {
      const profile = provider.profileDir("tenant-x", "staff-9");
      const pairing = fakeBrowser(profile);
      await until(() => browsersUsing(profile).length === 1);
      provider.sessions.set(provider.sessionKey("tenant-x", "staff-9"), { status: "QRCODE", client: null });
      await provider.closeSession("tenant-x", "staff-9");
      await until(() => !alive(pairing.pid));
      assert.equal(provider.hasSession("tenant-x", "staff-9"), false);
    } finally {
      ENV.TOKEN_DIR = saved;
    }
  });

  await t.test("starting a number first releases a stale browser holding its profile", async () => {
    const saved = ENV.TOKEN_DIR;
    ENV.TOKEN_DIR = root;
    try {
      const profile = provider.profileDir("tenant-x", "staff-7");
      const stale = fakeBrowser(profile);
      fs.symlinkSync("dead-lock", path.join(profile, "SingletonLock"));
      await until(() => browsersUsing(profile).length === 1);
      await provider.releaseProfile("tenant-x", "staff-7");
      await until(() => !alive(stale.pid));
      assert.equal(fs.existsSync(path.join(profile, "SingletonLock")), false);
    } finally {
      ENV.TOKEN_DIR = saved;
    }
  });

  await t.test("the start-up sweep removes orphans but leaves browsers of a live worker alone", async () => {
    const live = fakeBrowser(path.join(root, "live", "live")); // its parent is this running Node process
    const outside = fakeBrowser(path.join(os.tmpdir(), `elsewhere-${process.pid}`)); // not under the token folder
    // An orphan: started by a shell that exits at once, so its parent is gone.
    const orphanDir = path.join(root, "orphan", "orphan");
    fs.mkdirSync(orphanDir, { recursive: true });
    const shell = spawn("sh", ["-c", `"${process.execPath}" -e "setInterval(()=>{},1e6)" -- --user-data-dir=${orphanDir} >/dev/null 2>&1 &`], { stdio: "ignore" });
    // it is an orphan only once that shell has gone (on a busy machine the browser can be seen before the shell has exited)
    await new Promise((resolve) => shell.on("exit", resolve));
    await until(() => browsersUsing(orphanDir).length === 1);
    await until(() => browsersUsing(path.join(root, "live", "live")).length === 1);

    const swept = await sweepOrphanBrowsers(root);
    assert.ok(swept >= 1);
    assert.equal(browsersUsing(orphanDir).length, 0, "the orphan is gone");
    assert.ok(alive(live.pid), "a browser owned by a running worker is not touched");
    assert.ok(alive(outside.pid), "browsers outside the token folder are not touched");
  });
});

test("Pairing errors show plain language and never server paths", () => {
  assert.match(
    friendlyStartError(new Error("The browser is already running for /opt/wppflow-backend/tokens/tenant_x_staff-9/tenant_x_staff-9. Use a different `userDataDir`")),
    /still shutting down/,
  );
  const cleaned = friendlyStartError(new Error("ENOENT: cannot open /opt/wppflow-backend/tokens/a/b/c.json now"));
  assert.ok(!cleaned.includes("/opt/"), cleaned);
  assert.equal(friendlyStartError(new Error("Timed out")), "Timed out");
});
