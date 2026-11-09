import "dotenv/config";

// The app first lived at a *.vercel.app address, then at scriwo.com. It now lives at app.scriwo.com
// (www.scriwo.com is the public website, which forwards old ?invite= links to the app). A server
// with the old Vercel address configured, or none, sends people to https://app.scriwo.com. Any other
// address set in APP_URL is respected as is.
const LEGACY_APP_ADDRESS = /^https?:\/\/[a-z0-9-]+\.vercel\.app$/i;
export function resolveAppUrl(configured, nodeEnv) {
  const url = String(configured || "").trim().replace(/\/+$/, "");
  if (nodeEnv === "production")
    return !url || LEGACY_APP_ADDRESS.test(url) ? "https://app.scriwo.com" : url;
  return url || "http://localhost:5173";
}

// A whole number from the environment, or the default when it is missing, not a number, or below the least that makes sense.
const whole = (name, fallback, min = 0) => {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

export const ENV = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: parseInt(process.env.PORT || "8080", 10),
  JWT_SECRET:
    process.env.JWT_SECRET ||
    (process.env.NODE_ENV === "production"
      ? null
      : "wppflow-dev-insecure-secret-key-32chars!!"),
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || "1h",
  JWT_REFRESH_EXPIRES_IN_DAYS: parseInt(
    process.env.JWT_REFRESH_EXPIRES_IN_DAYS || "7",
    10,
  ),
  DATABASE_URL:
    process.env.DATABASE_URL || "postgresql://localhost:5432/wppflow",
  REDIS_URL: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  // The production domain is always allowed, even when ALLOWED_ORIGINS is set on the server,
  // so a deploy can never lock the app out of its own API and live updates.
  ALLOWED_ORIGINS: [
    ...new Set([
      ...(process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
        : [
            "http://localhost:5173",
            "http://localhost:3000",
            "https://wppflow-beige.vercel.app",
          ]),
      "https://scriwo.com",
      "https://www.scriwo.com",
      "https://app.scriwo.com",
      // an industry's own address serves the same app (see services/vertical.js), so its browser calls and live updates are allowed too
      "https://homes.scriwo.com",
    ]),
  ].filter(Boolean),
  ENABLE_DEBUG_ROUTES: process.env.ENABLE_DEBUG_ROUTES === "true",
  TOKEN_DIR: process.env.TOKEN_DIR || "./tokens",
  BODY_LIMIT: process.env.BODY_LIMIT || "2mb",
  ENABLE_DEMO_SEED: process.env.ENABLE_DEMO_SEED === "true",
  AUTO_MIGRATE:
    process.env.AUTO_MIGRATE === undefined
      ? process.env.NODE_ENV !== "production"
      : process.env.AUTO_MIGRATE === "true",
  // How long an unscanned QR code stays valid before the pairing browser closes.
  QR_TIMEOUT_MS: parseInt(process.env.QR_TIMEOUT_MS || "180000", 10),
  // Keeping the linked numbers connected (docs/session-stability.md). Milliseconds unless the name says otherwise. The defaults are meant
  // to be left alone; they are settings so that the server can be tuned to its memory, and so that tests need not wait.
  // how often a running number renews its claim in the database, and how long a failing renewal (the database busy or restarting) is
  // tolerated before the number is let go: a healthy browser is never closed for one failed query
  SESSION_LEASE_TICK_MS: whole("SESSION_LEASE_TICK_MS", 10000, 50),
  SESSION_LEASE_GRACE_MS: whole("SESSION_LEASE_GRACE_MS", 300000, 0),
  // how often numbers that are down are looked for, how many browsers may be launching at once, and how long one launch is waited for
  SESSION_RECOVER_EVERY_MS: whole("SESSION_RECOVER_EVERY_MS", 30000, 50),
  SESSION_START_CONCURRENCY: whole("SESSION_START_CONCURRENCY", 2, 1),
  SESSION_LAUNCH_TIMEOUT_MS: whole("SESSION_LAUNCH_TIMEOUT_MS", 90000, 50),
  // a number that keeps failing is retried after this, doubling each time up to the maximum
  SESSION_RETRY_BASE_MS: whole("SESSION_RETRY_BASE_MS", 30000, 0),
  SESSION_RETRY_MAX_MS: whole("SESSION_RETRY_MAX_MS", 600000, 0),
  // stopping the server: the time given to close every number cleanly, to close one browser, and to a browser that is asked to quit
  // (SIGTERM) before it is forced to (SIGKILL). pm2's kill_timeout must be longer than SHUTDOWN_GRACE_MS.
  SHUTDOWN_GRACE_MS: whole("SHUTDOWN_GRACE_MS", 30000, 1000),
  BROWSER_CLOSE_TIMEOUT_MS: whole("BROWSER_CLOSE_TIMEOUT_MS", 15000, 50),
  BROWSER_TERM_GRACE_MS: whole("BROWSER_TERM_GRACE_MS", 5000, 0),
  // a connected number that fails this many checks in a row (one a minute) has its browser restarted, at most once per cooldown
  HEARTBEAT_RESTART_AFTER: whole("HEARTBEAT_RESTART_AFTER", 3, 1),
  HEARTBEAT_RESTART_COOLDOWN_MS: whole("HEARTBEAT_RESTART_COOLDOWN_MS", 600000, 0),
  // WhatsApp reports the connection down and it does not come back by itself within this long: the browser is restarted
  STREAM_DOWN_RESTART_MS: whole("STREAM_DOWN_RESTART_MS", 90000, 50),
  // 0 disables the periodic check that repairs messages missed by the live feed.
  SYNC_RECONCILE_MS: parseInt(process.env.SYNC_RECONCILE_MS || "300000", 10),
  // Base address of the web app, used in the links emailed to people.
  APP_URL: resolveAppUrl(process.env.APP_URL, process.env.NODE_ENV),
  SUPERADMIN_EMAIL: (process.env.SUPERADMIN_EMAIL || "karnveer@scriza.in").toLowerCase().trim(),
  SUPERADMIN_PASSWORD: process.env.SUPERADMIN_PASSWORD || "",
  ALLOW_PUBLIC_SIGNUP: process.env.ALLOW_PUBLIC_SIGNUP !== "false",
  RESEND_API_KEY: process.env.RESEND_API_KEY || "",
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL || "Scriwo <noreply@scriwo.com>",
  // Where website enquiries are sent. Defaults to the platform admin.
  LEADS_EMAIL: (process.env.LEADS_EMAIL || process.env.SUPERADMIN_EMAIL || "karnveer@scriza.in").toLowerCase().trim(),
  MAIL_FROM: process.env.MAIL_FROM || process.env.RESEND_FROM_EMAIL || "Scriwo <noreply@scriwo.com>",
};

if (ENV.NODE_ENV === "production") {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error(
      "❌ FATAL: JWT_SECRET environment variable is missing or too short in production (min 32 chars).",
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error(
      "❌ FATAL: DATABASE_URL environment variable is required in production.",
    );
    process.exit(1);
  }
}
