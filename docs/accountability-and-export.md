# Accountability and portability

## What the machine said: `automation_audit`

Every message Riwo or a rule sends to a customer is written to an append-only record (migration 046). A row says:

| Field | Meaning |
|---|---|
| `source`, `rule_ref` | What allowed it: `autopilot` (`saved_replies`), `sales_assistant` (the rule id, or the hand-off and why), `riwo_chat`, `rule` (an automation rule), `handoff_notice`; `unlabelled` if a caller forgot to say |
| `trigger_message_id` | The customer message that started it |
| `provider`, `model` | Which AI service and model were involved (empty when no model was) |
| `text` | The exact words sent, including the "automated reply" line |
| `reversible` | Whether a person can take it back (Autopilot replies: yes, with Undo) |
| `event`, `undoes` | `sent`, `cleared` (a thank-you taken off the waiting list) or `undone`, which is a **new row** naming the row it reverses and who did it |
| `prev_hash`, `hash` | Each row carries the SHA-256 of the one before it, so an edited or missing row is found |

How it is guaranteed:
- It is written inside `sendTextMessage`, the only way a message reaches WhatsApp. Anything sent as "Riwo" or "Automation" is recorded, so nothing automated escapes by a caller forgetting to log it. People, broadcasts and private notes are not recorded here.
- A database trigger refuses `UPDATE` and `DELETE` (except when the whole company is deleted). A database owner can still switch the trigger off; the hash chain is what then shows the tampering.
- `GET /api/automated-messages` lists it (managers: everything; staff: chats they may open; `conversationId`, `limit`, `beforeId`). `GET /api/automated-messages/verify` (owner/admin) walks the chain. In the app: Admin → "Your data, and what Riwo said" → Check the record.

Not covered: messages sent by a person, broadcasts (they have their own results), and a failed write of the record (logged, and the message is still sent; a database failure that severe affects far more than this).

## Taking your data with you

Owners and administrators: `GET /api/export` (JSON) and `GET /api/export/messages.csv` (streamed in pages). The JSON has the company, team, contacts, labels, broadcast permission, conversations with who they are assigned to, the pipeline (stages, leads, history, follow-ups), saved replies and the automated-message record with its chain check. Pictures, voice notes and documents are not inside it; the messages CSV lists file names and the message they belong to.

Only the company's own rows are read; CSV cells that a spreadsheet would run as a formula are prefixed with `'`; each export is written to the audit log (`company.exported`); six exports an hour per company.

## Validating with real providers (before the first paying agency)

Nothing above has been seen with a real WhatsApp number or real AI providers. Before anyone pays:
1. Add at least two provider keys (`add-ai-key`), then Admin → Riwo → "Run a test": every connected provider must answer.
2. Link a spare number. Switch on the Sales assistant with your own questions and website, then play five scripted customers: a plain enquiry, one who asks for pricing in the first message, one in Arabic, one who writes "human", one who sends a long rambling message. Read each message in the chat and the automated-message record side by side.
3. Check Private mode refuses a provider that may keep messages; watch a provider hit its limit and the others carry on.
4. Run the five design-partner agencies for two weeks with the owner watching Today every day. Write down every message a person had to correct.
