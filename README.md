# WppFlow backend

Tenant-owned WhatsApp shared inbox using WPPConnect 2.3.4, Express, Socket.IO, PostgreSQL and Redis/BullMQ. This repository is the API; the React interface is [wppflow](https://github.com/getkcoin-alt/wppflow).

## Local setup

Use Node 22+, PostgreSQL 16+ and Redis. Create a dedicated local application database and configure the values shown in .env.example. Never use production credentials for local tests.

```sh
npm ci --ignore-scripts
npm run db:migrate
npm start
```

For real WhatsApp connectivity, also install system Chromium and configure PUPPETEER_EXECUTABLE_PATH. Keep PUPPETEER_SKIP_DOWNLOAD=true when using system Chromium. Media is unavailable until a private S3-compatible bucket is configured. No demo records are seeded.

## Tests

```sh
npm test
```

The runner creates uniquely named local PostgreSQL databases, applies migrations, executes each suite and drops only those disposable databases. TEST_DATABASE_ADMIN_URL defaults to a local Postgres administrative connection. Non-local test targets are rejected. Provider calls are stubbed; tests never pair a device, send WhatsApp messages or use production data.

## Implemented operations

- Password login/signup, HttpOnly rotating refresh cookies, verified memberships and workspace switching.
- Owner/admin invitations with expiring single-use setup links; no invitation email is claimed or sent. Existing accounts must prove their password.
- Workspace sessions with QR/status polling, manager-only QR access, quotas, worker leases, restart recovery and credential-preserving disconnect.
- Contacts/import/export support, tags, custom traits and recorded campaign opt-in.
- Compound-cursor conversations/messages, assignments, resolve, private notes and saved canned replies.
- Transactional outgoing outbox, provider-ID deduplication, monotonic receipts, early-ACK and outgoing-echo reconciliation.
- Campaign recipient persistence, scheduling, opt-in/suppression enforcement, actual dispatch pacing and pause/stop checks.
- Keyword reply/assignment automations, unique executions and bounded failure retries.
- Automations can also start on a number from another country, and "Let Riwo chat" holds a short, checked conversation (answers only from text the company wrote, stops when a person replies); state lives in `automation_chats` (migration 032).
- Measured workspace aggregates, audit records, scoped hashed API keys, signed public-HTTPS webhook deliveries and retry logs.
- Private object-storage uploads/downloads, tenant-owned attachments and supported incoming media capture.
- Industry solutions (`src/solutions/`): optional, off by default, switched on per company by a platform admin. Scriwo Real Estate adds lead qualification, property inventory with rule-based matching, viewings and a revenue-leak detector under `/api/solutions/real_estate`. It needs the `leads` plan feature, adds tables only (migrations 030 and 031) and sends nothing to WhatsApp by itself. How it works, how to add another industry and what is not built: `docs/industry-solutions-progress.md` in the app repository.

## Important limits

Database/provider acceptance is not proof that a recipient received a message. Uncertain sends are never automatically resent. An in-flight provider call cannot be recalled by a campaign stop request. A provider ID with ACK 0 stays pending.

Use one API/Chromium worker initially. Database leases prevent a second worker owning the same browser, but distributed socket adapters and worker-specific routing have not been validated. History sync imports up to 100 provider messages per requested conversation; it is not a complete account-history backup.

Store orders/LTV, billing/plan administration, email delivery, calls, reactions, editing/deleting WhatsApp messages and exact WhatsApp visual parity are not implemented. Their data is not fabricated. Media content checks are not antivirus scanning; configure bucket lifecycle/quarantine and an actual malware scanner before accepting untrusted public uploads.

See [release checklist](docs/release.md) before upgrading an existing installation. Production migrations are manual by default and destructive rollback is disabled.
