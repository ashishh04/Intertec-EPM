# Analytics — design

Analytics is history. Everything EPM already reports is *today* — the dashboard, the
reports page, the executive view. None of it can answer "how did this change", because
nothing was recorded. That is the gap this closes, and it is deliberately the only one.

## Phase 1 — what the discovery found

### A snapshot mechanism already exists

`routes/dashboard.ts` already writes and reads history:

```ts
// Records today's values so tomorrow's trends have something to compare to.
async function recordSnapshots(values: Record<string, number>, scopeUserId: string)
  → prisma.metricSnapshot.upsert({ where: { scopeUserId_sampledOn_metric: … } })

async function trendFor(metric, current, scopeUserId, positiveIsUp)
  → compares against a snapshot at least 7 days old, and reports **flat** when
    there is none rather than inventing a percentage
```

That already satisfies most of what Phase 3 asks for. The upsert on a unique key makes it
**idempotent**; `sampledOn` is a `@db.Date`, so the period is a day; rerunning it the same
day overwrites rather than duplicating. And `trendFor` already refuses to fabricate.

### Existing data

Real, and not to be destroyed:

| measure | value |
|---|---|
| rows | 20 |
| distinct metrics | 4 (`myTasks`, `inProgress`, `overdue`, `activeProjects`) |
| distinct days | 2 |
| scopes | user ids 4, 5 and 6 |

User 5 no longer exists in the directory. That orphan is left alone — it is what was true
on the day it was recorded, which is the whole point of a snapshot.

### The one thing missing

```prisma
scopeUserId String?   // null means instance-wide
@@unique([scopeUserId, sampledOn, metric])
```

A snapshot can be scoped to a **user** or to nothing. There is no way to record a metric
for a portfolio, a team or a department — which is exactly what org-level history needs.

### Existing analytics surface

`AnalyticsPage` renders executive insights, delivery trends, a status distribution and a
per-project health matrix. All **current state**, computed per request. `ReportsPage` is the
same. Neither reads a snapshot. So this work adds history rather than replacing anything.

## Scope

**Current state** stays where it is. The dashboard, reports and executive views already
compute it live and correctly; duplicating those calculations into an analytics module
would create a second answer to the same question.

**History** is new: metrics captured per day per scope, queried as a series.

Every figure the UI shows is labelled as one or the other. A number computed live and a
number read from a snapshot are different claims and are not mixed in one chart.

## MetricSnapshot — the final model

The smallest change that supports org-level history: generalise the scope from *a user* to
*a typed reference*.

```prisma
model MetricSnapshot {
  id         String   @id @default(cuid())
  /// What the row is about: instance, user, portfolio, team or department.
  scopeType  String   @default("instance")
  /// The id within that type. Null only for `instance`.
  scopeId    String?
  sampledOn  DateTime @db.Date
  metric     String
  value      Float
  createdAt  DateTime @default(now())

  @@unique([scopeType, scopeId, sampledOn, metric])
  @@index([scopeType, scopeId, metric, sampledOn])
  @@index([metric, sampledOn])
  @@map("metric_snapshots")
}
```

`scopeUserId` becomes `scopeId`, and `scopeType` is added beside it. The migration renames
rather than drops, so all 20 existing rows survive with `scopeType` set from whether the id
was null. No second snapshot table is created.

The scope is **not** a foreign key. A snapshot records what was true then; a department
deleted later must not take its own history with it, and `ON DELETE RESTRICT` would make
deleting one impossible once it had ever been measured.

| property | how |
|---|---|
| deterministic | the same day and the same state produce the same rows |
| attributable to a period | `sampledOn` is a date; the period is one day |
| idempotent | upsert on `(scopeType, scopeId, sampledOn, metric)` — rerunning overwrites |
| queryable | indexed on scope + metric + date |
| safe to rerun | by construction; no row is ever appended twice |

## Metrics

Only metrics with defensible semantics. Each names what it counts, not a vague quality.

| scope | metric | meaning |
|---|---|---|
| instance | `projects.total` | projects visible to the snapshot author |
| instance | `projects.active` | of those, not archived upstream |
| instance | `health.healthy` / `.warning` / `.critical` | active projects by **effective** health |
| instance | `employees.mapped` | people with a team or department |
| instance | `capacity.hours` | weekly hours of mapped people, each counted once |
| portfolio | `projects.total`, `projects.active` | its projects |
| portfolio | `health.healthy` / `.warning` / `.critical` | its projects by effective health |
| portfolio | `members`, `capacity.hours` | distinct people across its projects |
| team | `members`, `capacity.hours` | people mapped to it |
| department | `members`, `capacity.hours` | people mapped to it |

All reuse the existing rollups — `rollups()` for teams and departments, the portfolio
domain for portfolios, `effectiveHealth` for health. Nothing is recalculated, and no rule
is invented.

### What is deliberately not captured

**Workload and allocation.** Two independent reasons, either of which is sufficient:

1. `value` is a non-null `Float`. Allocation is `null` when capacity is zero — an explicit
   representation established in Capacity precisely so it would not read as "nothing
   logged". Storing it would mean turning that null into a zero, which is the thing the
   requirement forbids.
2. Allocation is *this week's* logged hours over weekly capacity. A daily snapshot of a
   weekly running total measures a partial week, so a trend line would sawtooth — climbing
   through each week and collapsing every Monday — and read as a decline that never
   happened.

Reconstructing it properly needs a weekly snapshot period alongside the daily one, which
is a bigger change than this feature justifies. Recorded as a limitation.

### Archived and unmapped

| case | treatment |
|---|---|
| archived team or department | **still measured**. Archiving is a visibility decision, and its people are still there — the same rule the live rollups follow. |
| archived portfolio | still measured, for the same reason. |
| project archived upstream | counted in `projects.total`, not in `projects.active`. |
| unmapped employee | in no team or department, so in no team or department metric. Not in `employees.mapped`. |
| zero capacity | counted as a member, contributing 0 hours. A member with no availability is not the same as no member. |
| empty team, department or portfolio | a row of `0`, not an absent row. Zero is an answer. |
| person on two projects in a portfolio | counted **once** — the distinct rule the portfolio contract already establishes. |

## Snapshot generation

`POST /api/analytics/snapshots`.

No scheduler is introduced. The project has none, and adding one for a daily write would be
more machinery than the problem needs — an operator's own cron can call this, or it can be
triggered by hand. The endpoint:

1. computes every supported metric from the current EPM and OpenProject state,
2. writes them in **one transaction**, so a partial day never lands,
3. upserts, so calling it twice on the same day overwrites rather than doubling,
4. returns what it captured — the date, the row count and a per-scope breakdown.

The existing per-user dashboard snapshot is left exactly as it is. It writes four
user-scoped metrics as a side effect of loading the dashboard, which is how the two days of
history already in the database got there.

## API

| method | path | purpose |
|---|---|---|
| GET | `/api/analytics/overview` | current state, plus how much history exists |
| GET | `/api/analytics/trends` | a metric series; `?metrics=`, `?scopeType=`, `?scopeId=`, `?days=` |
| POST | `/api/analytics/snapshots` | capture today |

Three, each backing something the UI actually shows. `overview` reports coverage —
`firstSnapshot`, `lastSnapshot`, `days` — so the frontend can tell the difference between
"no history yet" and "a flat line", and say so rather than drawing an empty chart.

No raw rows are exposed: a trend is `{ metric, scope, points: [{ date, value }] }`.

## Authorization

| operation | permission |
|---|---|
| view analytics | authentication only |
| generate a snapshot | **`analytics:manage`** |

Reading is open, matching every other EPM read surface. Generating is not: it writes data
that becomes the historical record, and a bad or partial run is not something an ordinary
user should be able to cause. That is a real distinction rather than an invented one, and no
existing permission covers capturing metrics — the others are all about org structure or a
project's health.

Granted from `epm_permission_grants` and the `EPM_ADMIN_USER_IDS` bootstrap. No new
mechanism, no Roles UI.

## Performance

Trend queries read only `metric_snapshots` — indexed on `(scopeType, scopeId, metric,
sampledOn)` — and never touch OpenProject. That is the point of snapshotting: the expensive
part happens once a day, not on every page load.

Snapshot generation itself reads OpenProject once for the project list and its aggregates,
reusing the same loaders the project routes use, so it makes no per-project or per-user
request. Everything else comes from the EPM database.

## Empty and missing data

- **No snapshots**: the overview reports `days: 0`, and the UI shows an empty state saying
  history begins at the first snapshot. No chart is drawn.
- **One snapshot**: a single point. A trend line is not drawn from one point; the UI says
  so.
- **Missing days**: gaps are left as gaps. Points are returned as recorded, not
  interpolated — a day nobody captured is not a day with a value.
- **Null**: never stored. A metric that cannot be calculated is not recorded, rather than
  recorded as zero.

## Known limitations

Recorded after implementation; see the end of this file.
