# Analytics scheduler — design

Analytics records history, but only on the days somebody remembers to ask for it. This
makes the asking automatic. That is the whole objective — it is not a job system.

## Phase 1 — what the discovery found

### No scheduler exists

Zero occurrences of `setInterval`, `cron`, `scheduler`, `worker` or `background` in the
backend. The single `setTimeout` is a retry sleep inside the OpenProject client. So there is
no existing mechanism to reuse and none to avoid duplicating.

### The identity problem was already solved

`auth/context.ts` says so in its own comment:

> When nothing is set the client falls back to the configured API key. That path is for
> unattended work — the health probe, **scheduled sync** — not for user requests.

`OpenProjectClient.authorization` reads the async-local auth context and falls back to
`OPENPROJECT_API_KEY` when there is none. So a scheduled capture needs **no invented user,
no hardcoded identity and no credential of its own**: running outside any request context is
itself the answer, and the credential is the one the backend was already configured with.

That also fixes a limitation Analytics documented. A user-triggered capture records only the
projects that user can see, so a restricted capturer would write a smaller instance than
exists. A scheduled capture always sees what the service credential sees.

### Startup and shutdown

`index.ts` builds the app, listens, and closes on `SIGINT`/`SIGTERM`. `app.ts` already has
an `onClose` hook that disconnects Prisma, so there is an established place to stop a timer.
Logging is Fastify's `app.log`, structured, with `{ err }` for errors.

### The snapshot service

`captureSnapshot(projects, portfolios)` in `domain/analytics.ts` does the calculation and the
write. `routes/analytics.ts` composes its inputs — projects for the caller, then portfolios
rolled up from them. That composition is what both callers need, so it is exported as
`runSnapshot(signal)` and the route becomes one of its two callers rather than its owner.

There remains exactly one implementation of the calculation.

## Mechanism

An in-process `setInterval`, and nothing more. The deployment is a single Node process
beside a single Postgres; a job table, a queue or a worker would be machinery for a problem
this does not have.

```
setInterval → runSnapshot(signal) → captureSnapshot → MetricSnapshot
```

The timer is `unref()`d, so it never holds the process open on its own, and it is cleared
from the existing `onClose` hook.

### Multiple instances

Two backends would both fire. That is **safe but wasteful**, and safe is the part that
matters: every row is upserted on `(scopeType, scopeId, sampledOn, metric)`, so two captures
on the same day produce one set of rows regardless of who ran them or in what order. The
worst case is duplicated work, not duplicated history.

There is no lock. A lock would need a table and a lease, which is the job system this is
explicitly not. If the deployment ever becomes multi-instance and the wasted work matters,
the smallest fix is an advisory lock on the capture, not a scheduler rewrite.

## Schedule and period

| setting | default | meaning |
|---|---|---|
| `EPM_ANALYTICS_SNAPSHOT_ENABLED` | `false` | off unless asked for |
| `EPM_ANALYTICS_SNAPSHOT_INTERVAL_MINUTES` | `1440` (daily) | how often to capture |

**Disabled by default**, deliberately. A scheduler that starts itself would write to the
metric table during every test run and every developer's `npm run dev`, which is exactly the
"do not start during tests unless explicitly enabled" requirement — and the safe default for
something whose whole job is writing history.

The interval is validated at startup by the existing Zod schema with a **floor of 5
minutes**. A typo like `0` or `-1` fails startup with a message rather than producing a
scheduler that captures continuously.

### The period a snapshot represents

One **UTC day**. `sampledOn` is a `@db.Date` derived from `toISOString().slice(0, 10)`, so
the day boundary is midnight UTC regardless of where the server sits. A sub-daily interval
therefore does not create more history — it overwrites the same day's rows with fresher
values, which is a reasonable thing to want and is why the interval is configurable below a
day at all.

There is no timezone setting. Introducing one would mean deciding whose day a snapshot
belongs to, and nothing has asked.

## Authorization and actor

| capture | credential | permission |
|---|---|---|
| manual, `POST /api/analytics/snapshots` | the caller's OAuth token | `analytics:manage` |
| scheduled | the configured API key, via the no-context fallback | none — it is not a request |

The scheduler is not a user and is not subject to a user permission. It runs inside the
backend that already holds the credential; there is nothing to grant it.

### What the schema records

`MetricSnapshot` has no author column, so a scheduled capture and a manual one are
indistinguishable in the data. **This is a deliberate non-change.** A row states what was
true on a day; who pressed the button does not change that, and both paths run the same
calculation over the same source. Adding an author column would be schema churn for a
question nobody has asked, and it would make the two look like different kinds of fact when
they are the same fact.

Recorded as a limitation rather than fixed.

## Idempotency

Unchanged, and verified rather than assumed. Every row is upserted on
`(scopeType, scopeId, sampledOn, metric)`, a unique key with **no nullable column** — the
instance scope uses `''` rather than `null` precisely because Postgres treats NULLs as
distinct and would otherwise let a second copy in.

So for one day:

- running twice → the same rows, updated
- running after a restart → the same rows, updated
- running after a failure → the same rows, completed
- two instances running at once → the same rows; the later write wins, and both computed the
  same values from the same source

All four scopes — instance, portfolio, team, department — go through the same upsert. The
existing Analytics tests already assert the row count does not move across two captures; the
scheduler adds nothing that could change that, because it calls the same function.

## Failure behaviour

| situation | behaviour |
|---|---|
| OpenProject unavailable | the capture throws, is caught, and is logged as a warning. No rows are written. The next tick tries again. |
| EPM database unavailable | same. The transaction never opens. |
| one scope's calculation fails | the whole capture fails. Samples are collected before anything is written, so a scope that throws aborts the run rather than producing a day that looks complete but is missing a portfolio. |
| the transaction fails | Prisma rolls it back. A partial day cannot land. |
| a capture takes longer than the interval | the next tick is **skipped**, not queued. An in-flight flag guards it, so a slow capture cannot pile up behind itself. |
| anything unexpected | caught at the tick boundary. A failed capture never crashes the backend and never stops the timer. |

The backend serves requests throughout: the first capture is deferred past startup, and
nothing about the API waits on it.

## Restart and missed periods

**Option A: capture the current state only. No backfill.**

Three days of downtime leave three days of gaps, and they stay gaps. Backfilling would mean
writing yesterday's date against today's numbers, which is the fabrication this whole feature
was built to avoid — a snapshot is a claim about a day, and there is no source from which a
past day's project health or team capacity can be reconstructed.

The chart already handles this correctly: `connectNulls={false}`, so a gap is drawn as a
break rather than bridged.

On startup the scheduler waits a short delay, then captures once, then settles into its
interval. So a restart after downtime records today promptly rather than waiting a full day.

## Logging

Through `app.log`, structured, at startup and per capture:

```
info  Analytics snapshot scheduler enabled   { intervalMinutes, firstRunInSeconds }
info  Analytics snapshot scheduler disabled  (when off)
debug Analytics snapshot starting
info  Analytics snapshot captured            { sampledOn, records, scopes, durationMs }
warn  Analytics snapshot failed              { err, durationMs }
warn  Analytics snapshot skipped             (previous run still in flight)
```

No token, session id, password or API key is logged. The only configuration values logged
are the interval and the enabled flag, neither of which is a secret.

## Frontend

No scheduler UI, no scheduler configuration exposed. The Analytics page gains one thing: the
date of the most recent snapshot, which it already receives in `history.lastSnapshot` and
was not displaying. Manual capture stays where it is for administrators.

## Test results

41 cases in `npm run test:authz`. Suite total **701 passed, 0 failed** — the 660 that
existed before are unchanged.

**No test waits for real time.** The scheduler is exercised through its exported `tick`,
with a stubbed capture, so none of the behavioural cases touch OpenProject or the clock:
starting, refusing to start twice, stopping, stopping twice, a capture that throws being
caught and retried, and an overlapping tick being skipped rather than queued. The log lines
are captured and asserted to contain no token, session id, password or key.

The idempotency cases assert **row counts**, not status codes:

- an unattended capture with `currentAuth() === undefined`, proving the scheduler needs no
  user — it authenticates by running outside a request context
- rerunning reports the same record count and adds no rows
- two **concurrent** captures still leave one set of rows
- every scope — instance, portfolio, team, department — grouped and asserted to have exactly
  one row per metric per day

The trend regression uses fixture rows written directly, so "two snapshots make a trend"
does not depend on waiting a day: one point is asserted insufficient, a second makes a
trend, recapturing the same period updates a point rather than adding one, and a missing day
stays a gap. Manual capture is asserted to still work and still be refused without the
grant.

Configuration was verified at startup rather than assumed: disabled by default logs
"scheduler disabled", enabling logs the interval, and `EPM_ANALYTICS_SNAPSHOT_INTERVAL_MINUTES=0`
**fails startup with a message** rather than producing a scheduler that captures
continuously.

Browser sweep clean on eight routes for both identities. The restricted identity sees the
trends and no capture button. No scheduler control, interval or configuration value appears
anywhere in the UI or the bundle; `EPM_ANALYTICS` returns zero alongside the other eight
audit patterns.

## Test data

`rows=20  user=20  other=0` — the twenty real user-scoped rows are untouched, and every row
the tests wrote is removed. Cleanup collects the days captured by both the analytics and
scheduler sections and deletes only non-user scopes on those days, plus the fixture scopes
by id.

## Known limitations

1. **No author on a snapshot.** `MetricSnapshot` has no column for who captured it, so a
   scheduled row and a manual one are indistinguishable. Deliberate: a row states what was
   true on a day, both paths run the same calculation over the same source, and an author
   column would be schema churn for a question nobody has asked.
2. **No lock across instances.** Two backends would both capture. Safe, because the upsert
   collapses them to one set of rows, but wasteful. A Postgres advisory lock is the smallest
   fix if that ever matters.
3. **No backfill.** Downtime leaves gaps and they stay gaps. There is no source from which a
   past day's health or capacity could be reconstructed, and writing today's numbers against
   yesterday's date would be a fabrication.
4. **The first capture is 30 seconds after startup.** A process that restarts more often
   than that never captures. Not a realistic deployment, but it is the failure mode.
5. **A sub-daily interval does not create more history.** It refreshes the same UTC day's
   rows. Anyone expecting hourly granularity would need a period column, not a shorter
   interval.
6. **No retention.** Rows accumulate at roughly one per metric per scope per day, and
   nothing prunes them — carried over from Analytics.
7. **The schedule is fixed-interval, not wall-clock.** "Every 1440 minutes" drifts from
   midnight as the process restarts; it is not "at 02:00 daily". Since the period is a whole
   UTC day and captures are idempotent, the drift changes only *when* today's row is written,
   not which day it belongs to.
