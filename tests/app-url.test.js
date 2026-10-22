import test from "node:test";
import assert from "node:assert/strict";
import { resolveAppUrl } from "../src/config/env.js";

test("Emailed links point at the real domain", () => {
  // Production servers that still carry the old Vercel address, or none, use app.scriwo.com.
  for (const configured of ["https://wppflow-beige.vercel.app", "https://wppflow-beige.vercel.app/", "https://some-preview-abc.vercel.app", "", undefined])
    assert.equal(resolveAppUrl(configured, "production"), "https://app.scriwo.com", String(configured));
  // A deliberately chosen address is respected, minus any trailing slash.
  assert.equal(resolveAppUrl("https://app.example.com/", "production"), "https://app.example.com");
  assert.equal(resolveAppUrl("https://www.scriwo.com", "production"), "https://www.scriwo.com");
  // Development and tests keep working against a local app.
  assert.equal(resolveAppUrl(undefined, "development"), "http://localhost:5173");
  assert.equal(resolveAppUrl("http://localhost:3000/", "test"), "http://localhost:3000");
});
