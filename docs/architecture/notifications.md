# Team notifications

In-app notifications, stored in Postgres (`notifications`) and pushed live over Socket.IO (`notification:new` to the
recipient's own room, `user:<id>`). Nothing is lost if someone is offline: the bell loads them on the next visit.

## Who is told about what

| Event | Type | Recipients |
|---|---|---|
| Internal team note on a chat | `note` | The teammate it is assigned to, and the staff member whose WhatsApp number it is |
| Note contains `@Full Name` | `mention` | That teammate — only if they could open the chat |
| Chat assigned to someone | `assignment` | The assignee |
| A paired phone drops unexpectedly | `session` | The staff member who owns it and the workspace owners/admins (one alert per 10 minutes per number) |

Rules that always hold: the person who caused the event is never notified of it; nobody is notified about a chat they
could not open; each person only ever reads and clears their own notifications.

## Assignment gives access

Staff normally see only chats from their own WhatsApp number. **Assigning a chat to a teammate lets that teammate open
it** (conversation list, messages, replying, notes, live updates) until it is unassigned. Without this an assignment
would point at a chat the assignee cannot see. Assignment is stored by user id (`conversations.assigned_user_id`) next to
the display name; migration `010` backfills ids only where a name identifies exactly one active teammate.

## API

- `GET /api/notifications?limit=&cursor=&unread=true` → `{ notifications, unreadCount, nextCursor }`
- `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`
- `GET /api/conversations/:id` — open a chat straight from a notification
- `PATCH /api/conversations/:id` accepts `assignedUserId` (preferred) or `assignedTo` (display name); empty `assignedTo` unassigns

## In the browser

Bell with unread count, toasts for new notifications, a browser-tab title badge, optional desktop alerts when the tab is
in the background (the person must opt in once), and a desktop alert for new customer messages when the tab is hidden.
Clicking any of them opens the chat.

## Not yet

Email or push notifications for people who are logged out, per-person mute settings, and notifying on every customer
message (this would flood; the list badges and desktop alerts cover it). These are natural next steps.
