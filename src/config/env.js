import "dotenv/config";

// The app first lived at a *.vercel.app address. Production now uses its own domain, so a server that
// still has the old address configured (or none) sends people to https://scriwo.com. Any other address
// set in APP_URL is respected as is.
const LEGACY_APP_ADDRESS = /^https?:\/\/[a-z0-9-]+\.vercel\.app$/i;
export function resolveAppUrl(configured, nodeEnv) {
  const url = String(configured || "").trim().replace(/\/+$/, "");
  if (nodeEnv === "production")
    return !url || LEGACY_APP_ADDRESS.test(url) ? "https://scriwo.com" : url;
  return url || "http://localhost:5173";
}

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
