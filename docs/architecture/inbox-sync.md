# How the shared inbox stays in sync with WhatsApp

Goal: the team inbox should feel like WhatsApp itself — messages appear instantly, nothing is missing after a
reconnect, and no one presses a "sync" button.

## Principles

1. **PostgreSQL is the single source of truth.** Every message is stored once (unique on the provider's message id),
   so a duplicate event, a retry or a re-import can never create a second copy.
2. **Push for speed, pull for certainty.** Live events make the screen change immediately; a tiny "what changed
   since" request repairs any gap. Nothing relies on the socket never dropping.
3. **Send only what changed.** Events carry the data the screen needs, so browsers update in place instead of
   reloading lists. Reconciliation with WhatsApp fetches only chats whose activity is newer than ours.
4. **No cache layer that can go stale.** Indexed cursor queries on Postgres answer in milliseconds at this scale.
   A Redis read-cache would add invalidation bugs without making anything feel faster.

## The three paths

| Path | Trigger | What it does |
|---|---|---|
| Live | WhatsApp event | `handleIncomingMessage` stores the message idempotently, then emits `message:received` **with the updated conversation** to the session owner and company managers only. |
| First-time backfill | A phone connects and has no chats yet | `syncSession` imports contacts (batched), the chat list, and the last 30 messages of the 40 most recent chats, throttled, with `sync:progress` events for a "Syncing your WhatsApp… 12 of 40" banner. History import never raises unread counts or triggers automations/webhooks. |
| Reconcile | A phone reconnects, then every `SYNC_RECONCILE_MS` (5 min) | Compares WhatsApp's chat list with ours and re-reads only chats that are newer (max 25 chats × 20 messages). Repairs anything missed while the server was down. |
| Catch-up (browser) | Socket (re)connect, tab becomes visible, network returns, every 60 s | `GET /api/conversations/changes?since=` returns just the conversations changed after the last sync point (agents: their own sessions only). |

## In the browser

`src/services/realtimeCache.ts` applies events to the TanStack Query caches: a new message appends once (duplicates
collapse), the chat moves to the top with its unread badge, read receipts only move forward, and filtered lists
(unread / groups / search) include or drop the chat correctly. Before this, every event refetched six query families.

## Where Redis fits (and where it does not)

- Today: BullMQ job queue for outgoing messages (unchanged).
- Add **when you run more than one API/WhatsApp worker**: the Socket.IO Redis adapter so events reach browsers on any
  worker, and session ownership stays leased in Postgres (already implemented).
- Good next use: ephemeral presence — "Sam is typing / viewing this chat" — to stop two agents answering the same
  customer. That data is short-lived and belongs in Redis, not Postgres.

## Knobs

| Variable | Default | Meaning |
|---|---|---|
| `SYNC_RECONCILE_MS` | 300000 | Interval of the repair pass; `0` disables it. |
| `QR_TIMEOUT_MS` | 180000 | How long an unscanned QR stays valid. |

## Known limits

- WhatsApp Web, not the official Cloud API, is the data source: history depth is whatever the phone shares, and there
  is no guaranteed delivery from WhatsApp's side. The reconcile pass narrows the gap; it cannot close it completely.
- Messages recovered by backfill/reconcile are marked as history: they do not fire automations or webhooks.
- Older history than the first 30 messages of a chat loads when someone opens it (up to 100) and scrolls.

## Suggested next steps

1. Typing/viewing presence in Redis.
2. Trigram index (`pg_trgm`) for instant contact/phone search, and message search.
3. Thumbnails and lazy media download for the chat view.
4. Move the WhatsApp browsers into their own worker process so API restarts never touch phone sessions.
