import "dotenv/config";

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
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
    : [
        "http://localhost:5173",
        "http://localhost:3000",
        "https://wppflow-beige.vercel.app",
      ],
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
  APP_URL: process.env.APP_URL || "http://localhost:5173",
  SUPERADMIN_EMAIL: (process.env.SUPERADMIN_EMAIL || "karnveer@scriza.in").toLowerCase().trim(),
  SUPERADMIN_PASSWORD: process.env.SUPERADMIN_PASSWORD || "",
  ALLOW_PUBLIC_SIGNUP: process.env.ALLOW_PUBLIC_SIGNUP !== "false",
  RESEND_API_KEY: process.env.RESEND_API_KEY || "",
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL || "WppFlow <noreply@scriwo.com>",
  MAIL_FROM: process.env.MAIL_FROM || process.env.RESEND_FROM_EMAIL || "WppFlow <noreply@scriwo.com>",
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
