// AI agent access: the settings that are not per company. See docs/agents.md.

// What a key may do. Each level includes the one before it.
//   read   look at the inbox: chats, messages, contacts' labels, the team, saved replies, the knowledge base, follow-ups
//   reply  + answer customers on WhatsApp, leave team notes, mark chats read
//   full   + hand chats to teammates, close and reopen them, label them, make and finish follow-ups
export const LEVELS = ["read", "reply", "full"];
export const LEVEL_RANK = { read: 1, reply: 2, full: 3 };
export const LEVEL_LABELS = { read: "Read only", reply: "Read and reply", full: "Full inbox control" };

// A key is shown once, as "scr_ag_" and 40 hex digits; only its hash is stored.
export const KEY_PATTERN = /^scr_ag_[a-f0-9]{40}$/;

// The plan feature that includes agent access: the same plans as API keys and webhooks. Change it here to move the feature to
// another plan, or add a feature of its own in services/plans.js.
export const AGENT_FEATURE = "api";

export const MAX_AGENTS = 10; // keys that are not revoked, per company
export const MAX_TEXT = 4000; // longest message an agent may send
export const MAX_NOTE = 2000;

// What a new agent may do until the owner says otherwise
export const DEFAULTS = { perHour: 30, perDay: 200, perChatHour: 6, expiresInDays: 90, newChatsPerDay: 10, newChatsPerHour: 5 };
export const BOUNDS = { perHour: [1, 1000], perDay: [1, 10000], perChatHour: [1, 100], expiresInDays: [1, 730], newChatsPerDay: [1, 200], newChatsPerHour: [1, 100] };

// A call is counted for the minute limit per key; a stolen or looping key cannot flood the server
export const CALLS_PER_MINUTE = 120;
// Wrong or revoked keys from one address, per ten minutes, before that address is told to wait (successful calls do not count)
export const BAD_KEYS_PER_TEN_MINUTES = 40;

// How long the record of what an agent did is kept. (What was said to a customer is kept for good: in the chat and in the AI accountability record.)
export const KEEP_EVENT_DAYS = 30;
// A send that was reserved but never finished (the process stopped in between) stops counting after this
export const RESERVATION_SECONDS = 120;

// The line added to what an agent sends, unless the owner switched it off for that agent. A customer who answers "human" is
// handed to a person, exactly as with Riwo (services/handoffService.js).
export const DISCLOSURE = '🤖 AI assistant reply. Reply "human" to talk to a person.';
export const withDisclosure = (text) => `${String(text ?? "").trim()}\n\n${DISCLOSURE}`;

// The versions of the Model Context Protocol that this server speaks, newest first
export const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "scriwo", title: "Scriwo WhatsApp inbox", version: "1.0.0" };

export const levelAllows = (have, need) => (LEVEL_RANK[have] || 0) >= (LEVEL_RANK[need] || 99);
