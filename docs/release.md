# Release and migration checklist

Prepared 2026-10-14. This is a code release, not evidence of a completed production rollout.

## Current production boundary

The canonical backend at https://srv1628639.hstgr.cloud/health was observed on API version 2.7.0 with an active WhatsApp browser. The frontend Git integration automatically publishes main. The new frontend therefore has a fail-closed Vercel ignored-build check: production stays on the existing interface until this backend advertises a healthy apiContract: 3. Preview builds are permitted, but must use a compatible backend to exercise new features.

No production database migration, device pairing, credential-folder removal or real-message send was performed during implementation.

## Upgrade procedure — operator approval required

1. Confirm the actual host, service, source commit and database used by the canonical API. An old Railway deployment record is not proof that Railway owns the VPS endpoint.
2. Schedule a maintenance window. Back up PostgreSQL and the full WhatsApp token/browser-profile directory, and prove restore on a separate instance. Record table counts, ownership and session names.
3. Rehearse the migration against a restored database with device startup and outbound network traffic disabled. Compare source/destination counts, tags, messages and membership roles.
4. If legacy users share company labels, configure LEGACY_TENANT_MAP using verified user-to-workspace ownership. Labels alone never authorize a merge. Configure LEGACY_SESSION_OWNERS only for exclusively owned sessions; inspect the actual WPPConnect token/profile layout before attaching old credentials.
5. Review any already-applied migration records. Do not delete migration history to force a rerun. Migration 003 upgrades the previously tenant-aware schema. Ambiguous ownership or unique-key conflicts intentionally fail instead of deleting data.
6. Configure production DATABASE_URL, a stable strong JWT_SECRET, APP_URL, exact ALLOWED_ORIGINS, REDIS_URL and a persistent TOKEN_DIR. Keep AUTO_MIGRATE=false. Use Node 22+ and patched system Chromium. The frontend must reach the API through same-site /api rewrites for the default Lax refresh cookie; cross-site deployments need a separate reviewed cookie/CSRF configuration.
7. Stop the old worker gracefully. Run npm run db:migrate on the backed-up, approved target. Start exactly one new worker and check /health for status ok, database.connected true and apiContract 3.
8. Verify login, refresh after reload, workspace denial, session recovery/QR ownership and inbox history. Verify private notes create no provider dispatch.
9. With the owner's explicit permission and test recipient, validate one outgoing text, incoming text, delivery/read ACK, media upload/download, campaign pause/stop and automation. Do not use customer broadcasts as smoke tests.
10. Trigger/retry the held frontend Git deployment only after those checks. Confirm the canonical host's content and user journeys, not merely a successful upload.

## Rollback and monitoring

Keep the old source image, database backup and profile backup. Application rollback after an additive migration still needs compatibility verification; legacy tables are preserved but are not live dual-written copies. Automatic table-dropping rollback is deliberately disabled. Investigate increased errors, unowned session startup, missing history, duplicate provider sends or cross-tenant visibility immediately. Pause new campaign work before recovery.

Monitor outbox pending/uncertain records, failed automation executions, webhook retries, worker leases, PostgreSQL pool use and Chromium resource use. No monitoring system or alert delivery was provisioned here.

## Dependencies and live-test gaps

WPPConnect is pinned to stable 2.3.4 with WA-JS 4.6.1, sharp 0.35.5 and basic-ftp 6.2.3. The installation audit improved from 14 findings (10 high, 4 moderate) to 5 high findings in the upstream Puppeteer/extract-zip chain. No fixed extract-zip release was available during this check. Do not blindly apply the suggested downgrade/force fix. Chromium download is disabled in the container setup, reducing exposure to archive extraction during installation; this is not a clean security audit or a production-security sign-off.

Real Chromium pairing/restoration, private bucket operations, public webhook delivery, load testing and multi-worker distribution still need staging validation. A local real-Redis/BullMQ integration test verifies outbox replay across a Redis restart without duplicate provider calls. Local provider stubs verify contracts and no-duplicate control flow, not WhatsApp compatibility end to end.
