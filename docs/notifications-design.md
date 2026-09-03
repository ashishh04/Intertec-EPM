# Notifications — design

The UI for this already exists and works. What is missing is anything to put in it.

## Phase 1 — what the discovery found

### Notifications today are OpenProject's, not EPM's

`/api/notifications` is a **pass-through**. It reads `/api/v3/notifications`, translates
each one's `reason` into an EPM category, and returns them. Marking read POSTs
`read_ian` upstream. There is **no notification table in the EPM schema** — the word does
not appear in `schema.prisma`.

Recipient isolation therefore already holds, and holds for a good reason: OpenProject
returns notifications for whoever's token made the call, so a user cannot ask for
another's.

### The instance has none

`total: 0`. Nothing has ever been notified, which is why the feature looks empty.

### The frontend is already complete

`NotificationPanel` (header), `NotificationItem`, `NotificationsPage`, `TopHeader` badge,
`useNotifications`, `useUnreadCount`, `useMarkNotificationsRead`,
`useMarkAllNotificationsRead`. Unread count, list, read state, mark one, mark all, loading
and empty states are all built. `targetFor` deep-links to `/tasks/:id` or `/projects/:id`,
falling back to `/notifications`.

So Phase 11 is almost entirely done already, and this work is a backend one.

### The gap

EPM's own events — a project's health turning critical, someone's capacity changing, a
snapshot capture failing — have **nowhere to live**. OpenProject cannot hold them: they are
EPM concepts, and writing them upstream would invert the ownership boundary every other
feature has respected.

That is what this adds: storage for events that currently have none, merged into the read
surface that already exists. It is not duplicate storage, because there is nothing to
duplicate.

## What counts as a notification

A notification is **something a specific person should know about, that they would not
otherwise see**. That is a narrower set than "things that happened":

| kind | example | notification? |
|---|---|---|
| user-facing state change | a project you own turned critical | **yes** |
| system event | a snapshot was captured successfully | no — it is expected, and saying so daily is noise |
| audit trail | who changed a health pin | no — nothing reads an audit trail here |
| metric | `capacity.hours = 80` | no — that is `MetricSnapshot`, and it is a series, not news |
| log line | a request took 400ms | no |

The test each candidate has to pass: *would a person act on this, and would they miss it
otherwise?*

## Model

```prisma
model Notification {
  id          String    @id @default(cuid())
  /// The OpenProject user id this is for. Not a foreign key — OpenProject owns
  /// users, exactly as everywhere else in EPM.
  recipientId String
  /// Reuses the existing NotificationCategory vocabulary; EPM events are `system`.
  category    String
  title       String
  body        String
  /// An EPM route to open. Never an OpenProject URL.
  link        String?
  severity    String    @default("info")
  /// What happened, at the granularity where repeating it is not news. Unique
  /// per recipient: this is the deduplication, enforced by the database.
  dedupeKey   String
  readAt      DateTime?
  createdAt   DateTime  @default(now())

  @@unique([recipientId, dedupeKey])
  @@index([recipientId, createdAt])
  @@map("notifications")
}
```

`ProjectProfile` gains one nullable column, `lastNotifiedHealth`, holding the effective
overall health as of the last evaluation. Without it a *transition* cannot be detected at
all — health is computed per request and nothing remembers what it was.

The contract gains two optional fields: `severity`, so a critical health change reads
differently from an improvement, and `link`, so a notification about a team or an employee
can deep-link somewhere the existing `taskId`/`projectId` pair cannot express.

## Event sources and trigger rules

Three, each tied to a point where something actually happens.

### 1. Health

| trigger | rule |
|---|---|
| calculated health transition | evaluated during the daily snapshot, which already computes every project's effective health. Fires only when `effective.overall !== lastNotifiedHealth`. |
| health override changed | at the mutation point, `PATCH /projects/:id/health`, comparing effective health before and after. Fires only when the effective overall actually moves. |

Unchanged health produces nothing, however many times it is evaluated — the transition
check happens before anything is written, and the dedupe key would stop it even if it did
not.

Severity follows the new state: `critical` → critical, `warning` → warning, back to
`healthy` → info, worded as an improvement rather than an alarm.

Where an override is responsible for the effective state, the body says so explicitly, so
nobody reads a pinned green as a measured one. **No portfolio-level health is invented** —
these are per-project, which is the only level health exists at.

### 2. Capacity

Triggered at the mutation point, `PATCH /employees/:id/capacity`, when the stored value
changes. Values are already rounded to the quarter hour, so there is no float noise to
threshold against; any real change is material and a no-op write notifies nobody.

### 3. Snapshot failure

The scheduler already logs failures. It now also notifies, **once per failed day** — a
scheduler retrying every few minutes must not produce a notification per tick.

**Successful captures notify nobody.** A daily "it worked" is the noise this section exists
to avoid.

The body carries the day and a short reason. It does **not** carry a stack trace, a URL, or
anything from the error beyond its message — an upstream error can contain a request URL,
and that is exactly the kind of leak the audit checks for.

## Recipients

Only relationships that already exist. No new hierarchy, no subscription system.

| event | recipients | where the relationship comes from |
|---|---|---|
| project health | the project's owner | `EpmProject.ownerId`, from OpenProject's `responsible` link |
| capacity change | the employee, their team lead, their department manager | `UserProfile.teamId` → `Team.leadId`; `UserProfile.departmentId` → `Department.managerId` |
| snapshot failure | holders of `analytics:manage` | `epm_permission_grants` rows plus the `EPM_ADMIN_USER_IDS` bootstrap |

Each is deduplicated to a distinct set, so someone who is both an employee's team lead and
their department manager gets one notification, not two.

**A project with no owner notifies nobody**, and that is reported rather than worked around
— guessing at a recipient would be inventing the hierarchy this task is told not to build.
The same is true if no one holds `analytics:manage`: the failure is logged, as it already
was, and no notification is created rather than a fake recipient being conjured.

## Deduplication

The `dedupeKey`, unique per recipient, enforced by the database rather than by a check that
could race.

| event | key | why that granularity |
|---|---|---|
| health | `health:<projectId>:<newState>` | re-evaluating the same state is not news. Moving away and back later is, and produces a different key in between. |
| capacity | `capacity:<employeeId>:<from>-<to>:<day>` | the same change on the same day is one event; a later different change is another. |
| snapshot failure | `snapshot-failed:<day>` | one per failed day, however many ticks fail. |

Creation is an upsert on `(recipientId, dedupeKey)` that **updates nothing** on conflict, so
a repeat is a silent no-op rather than a resurrected notification jumping back to the top of
someone's list.

## API

The existing contract, extended rather than replaced:

| method | path | change |
|---|---|---|
| GET | `/api/notifications` | now merges EPM rows with the OpenProject ones, newest first |
| PATCH | `/api/notifications/read` | routes by id: `epm:`-prefixed ids update EPM rows, others go upstream |
| PATCH | `/api/notifications/read-all` | marks both sources |

EPM ids are prefixed `epm:` so the two sources cannot collide and each id routes to the
store that owns it. No new endpoint is added; `GET /:id` and pagination are not introduced
because the existing UI fetches the list and neither is needed.

## Authorization

Every EPM read filters on `recipientId = the caller`. Every write filters the same way, so
marking a notification read by guessing another user's id updates **zero rows** rather than
someone else's notification. Ownership is enforced in the query, not checked and then
trusted.

OpenProject notifications remain scoped by the caller's own token, as before.

## Realtime

**Not implemented, and deliberately out of scope.** There is no WebSocket or SSE
infrastructure in the application, and the requirement is explicit that Notifications must
not become the Realtime feature. The existing hook has a 20-second `staleTime`, so React
Query refetches on focus and navigation; that is the refresh model, unchanged.

## Known limitations

Recorded after implementation; see the end of this file.
