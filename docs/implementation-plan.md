# WppFlow implementation plan

Baseline: backend 7472e0d; frontend db037e0. Preserve the current interface and replace simulated behavior with verified tenant-owned operations.

## Sequence and acceptance

1. Database, permissions and private notes: fresh/legacy/previous-tenant upgrades; isolated integration tests; agents cannot manage users or access other tenants; notes never dispatch.
2. Authentication and sessions: cookie refresh, current membership checks, QR/status contract, safe session ownership, restart recovery and quotas.
3. Contacts and inbox: persisted contact/conversation CRUD, notes/assignment/resolve/canned replies, compound pagination, recoverable outbox and receipts.
4. Media: configured object storage, validated uploads, owned attachments and provider dispatch; unconfigured capability stays unavailable.
5. Campaigns and automation: persisted recipients/executions, authorized sessions, opt-in/suppression, durable cancellation-aware dispatch.
6. Admin/dashboard/developer tools: measured aggregates and audit, actual keys/API requests/webhook configuration and delivery logs. No fabricated telemetry or success fallbacks.
7. Verification and release: run clean installs, integration/component tests, production build, inspect changes, fetch remote updates, then push backend and frontend main without force. Check automatic deployment implications before the push. Live WhatsApp sends and production data migrations are not test fixtures.

## Verification approach

Backend tests create and remove a uniquely named LOCAL PostgreSQL database. Migrations run before fixtures. Provider calls are stubbed; no device is paired. Test cross-tenant denial, role escalation, note privacy, idempotency/concurrency, cursor ties, receipts, queue recovery, campaign control and integrations. Frontend tests exercise actual exported clients/components. Each module must persist across reload and show loading, empty and failure states.

## Data and infrastructure boundaries

PostgreSQL owns durable state; Redis/BullMQ dispatches work; WPPConnect owns WhatsApp browser connectivity; object storage owns media. Existing legacy credentials require explicit exclusive ownership. Unknown metrics are null/unavailable. Store integration is not configured by this implementation: order/LTV UI must say not connected. External credentials are environment values and must not enter commits or logs.

## Release evidence

Record tests, commit IDs, configuration prerequisites, migration limitations and verified remote main SHAs in the final report. Git push, CI completion and live application verification are distinct results.
