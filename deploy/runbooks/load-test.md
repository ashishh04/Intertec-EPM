# Runbook: load test (NFR01, BR-408)

NFR01: interactive views respond within 2 seconds at the 95th percentile under the modelled
concurrent load. The modelled load, agreed on 19 Oct 2026: **500 people at once over 100,000 work
packages**. BR-408 adds a 1,000-row task view, with calculated columns, within the same target.

Run it on a test instance sized like production, never on production and never on a shared
development machine: the numbers are only as good as the machine is quiet.

## 1. The data

`backend/openproject/load-test/load-data.rb` makes the people, projects and work through
OpenProject's own models (journals, memberships and the schedule as real use leaves them). It is
kept out of `setup/`, which is copied into the production image, and refuses to run unless
`LOAD_CONFIRM` names the instance's host.

```sh
docker cp backend/openproject/load-test/load-data.rb openproject:/tmp/load-data.rb
docker exec -e LOAD_CONFIRM=<host name> -e LOAD_PASSWORD='<password>' openproject \
  bash -lc 'cd /app && bundle exec rails runner /tmp/load-data.rb'
```

Defaults: 500 people (`lt-user-001` …), 50 projects (`lt-p-01` …), 100,000 work packages — a
tenth parents of five children, the rest standalone, one in five following the one before,
dated over the next six months, 2 to 40 hours each. Every person is in three projects, one in ten
as project admin. Re-running adds only what is missing. On the development laptop it made about
25 work packages a second, so allow 70 minutes for 100,000. Then let EPM's analytics catch up:
Administration → Analytics model → full refresh.

## 2. The run

`backend/src/scripts/load-test.ts` signs each person in and has them work as a person does, a
screen at a time with a pause (5 s on average) between: home, their own work, the projects list,
a project's tasks (one in ten reads the 1,000-row view as five pages of 200), a task with its
comments, relations and files, the calendar.

Sign-in is limited to 10 a minute from one address — a defence against password spraying that
stays on — so the people sign in once, paced within it (about 55 minutes for 500), and their
sessions are kept in `.load-test/sessions.json` (gitignored: they are credentials) for later runs.

```sh
cd backend
LOAD_PASSWORD='<password>' npx tsx src/scripts/load-test.ts --base https://<test host>/api --sign-in-only
LOAD_PASSWORD='<password>' npx tsx src/scripts/load-test.ts --base https://<test host>/api \
  --users 500 --ramp 300 --duration 900 --report ../.load-test/report.json
```

It prints and saves p50, p95 and p99 for every screen and every route, the error rate and the
kinds of error, and exits 0 only if every screen's p95 is within 2,000 ms and errors are under
1 %. Watch `/metrics` alongside (p95 by route, OpenProject call times, the outbox): a slow screen
is usually OpenProject's web workers queueing (`OPENPROJECT_WEB_WORKERS`, no more than the
cores) rather than EPM.

BR-408's 1,000-row view with calculated columns has its own measurement, on the same quiet
instance: `env -u PORT npx tsx --env-file-if-exists=.env src/scripts/calculated-scale.ts`.

## 3. Afterwards

```sh
docker exec -e LOAD_CONFIRM=<host name> -e LOAD_ACTION=remove openproject \
  bash -lc 'cd /app && bundle exec rails runner /tmp/load-data.rb'
rm -rf .load-test
```

Record the date, the instance's size (cores, memory, OpenProject workers), the report and what
was changed between runs.

## Trial on the development laptop (19 Oct 2026)

The tools were proven at small scale — 4 people, 2 projects, 40 work packages, 40 seconds, 1 s
pauses — then removed: 108 and 184 requests, no errors. The numbers are not a result: the laptop
was running OpenProject, two EPM backends and other work. They did show where to look first.
Each route alone answered in about 0.9 s the first time and about 10 ms once cached, but
concurrent first visits queued behind OpenProject's four web workers (home screen p95 8.6 s, warm).
Each person's first screens fan out to OpenProject with cold caches, so the ramp-up is the
moment to watch at 500.
