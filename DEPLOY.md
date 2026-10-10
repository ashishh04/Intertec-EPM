# Deploying EPM

Two ways to run the stack. They produce the same four containers.

| | Builds on the host | Use when |
|---|---|---|
| `docker-compose.deploy.yml` | no — pulls published images | normal deployments |
| `docker-compose.prod.yml` | yes — builds from this checkout | you are changing code on that machine |

The deploy file is the one to use. It needs exactly two files on the server —
itself and `.env.prod` — and no checkout, no Node, no toolchain.

## One-time setup

### 1. Docker Hub credentials, in GitHub

Repository → Settings → Secrets and variables → Actions. Note which tab each
one goes on — they are not interchangeable:

| Tab | Name | Value |
|---|---|---|
| **Variables** | `DOCKERHUB_USERNAME` | your Docker Hub account name, which is also the namespace the images publish under |
| **Secrets** | `DOCKERHUB_TOKEN` | an access token with **Read & Write**, from hub.docker.com → Account settings → Personal access tokens |

The username is a variable, not a secret: an account name is not confidential,
and as a secret it is masked out of the logs, leaving every build line reading
`***/epm-web`. The token is a token and not your password, so it can be revoked
without changing how you sign in anywhere else. The workflow checks both are set
before it does anything, and says which tab is missing one.

### 2. Decide whether the images are public

The release workflow creates three repositories under your namespace the first
time it pushes:

```
<namespace>/epm-backend
<namespace>/epm-web
<namespace>/epm-openproject
```

**Docker Hub's free plan includes one private repository.** Three private ones
need a paid plan. Left public, anyone can `docker pull` them — the backend image
contains EPM's compiled server and its Prisma schema, and the web image contains
the built frontend. Neither holds a secret (every credential arrives as an
environment variable at run time), but both are the product.

Set the visibility you want on each repository in Docker Hub after the first
push. If three private repositories are what you want and you would rather not
pay, GHCR gives unlimited private packages free and the workflow is a short edit
away — the registry appears in three places in `.github/workflows/release.yml`.

### 3. The host

Docker and the compose plugin, port 80 and 443 open, and `EPM_DOMAIN` already
resolving to the machine. Then:

```bash
mkdir -p /srv/epm && cd /srv/epm
curl -O https://raw.githubusercontent.com/ashishh04/Intertec-EPM/main/docker-compose.deploy.yml
# plus .env.prod, copied from .env.prod.example in this repository and filled in
docker login            # only if the images are private
```

The domain must resolve **before** the first `up`. Caddy requests a certificate
on startup and the stack is unusable without one: the backend marks the session
cookie `secure` in production, a secure cookie is never sent over plain HTTP, so
on `http://` sign-in appears to succeed, the cookie is dropped, and the person
lands back on the login form with nothing in any log to explain it.

## Releasing

```bash
git tag v1.0.0
git push origin v1.0.0
```

Actions builds all three images and pushes `1.0.0` and `latest`. There is also a
**Run workflow** button on the *Release images* workflow that takes a tag, for
publishing from a branch without tagging it.

## Deploying

On the host, set `EPM_IMAGE_TAG` in `.env.prod` to the release, then:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env.prod pull
docker compose -f docker-compose.deploy.yml --env-file .env.prod up -d
docker compose -f docker-compose.deploy.yml --env-file .env.prod ps
```

The backend applies pending Prisma migrations as it starts (`migrate deploy`,
which only ever applies and never resets or prompts), so there is no separate
migration step. It reports unhealthy until both Postgres and OpenProject answer;
that is the readiness check doing its job, and it can take a minute on a cold
start while OpenProject boots.

Pin a version rather than tracking `latest`. With a version, `docker ps` tells
you what is deployed and a rollback is one edited line:

```bash
# roll back
sed -i 's/^EPM_IMAGE_TAG=.*/EPM_IMAGE_TAG=1.0.0/' .env.prod
docker compose -f docker-compose.deploy.yml --env-file .env.prod up -d
```

A rollback moves code, not data. A release whose migrations changed the schema
cannot be undone this way — restore the database alongside it.

## After the very first `up`

OpenProject starts empty, and three of its values have to come out of a running
instance and go into `.env.prod`:

1. `OPENPROJECT_API_KEY` — sign in as an administrator → My account → Access
   tokens → API.
2. `OPENPROJECT_OAUTH_CLIENT_ID` / `..._SECRET` — Administration →
   Authentication → OAuth applications. Sign-in needs these: EPM exchanges a
   person's credentials for a token on their behalf.
3. Optionally `OPENPROJECT_WEBHOOK_SECRET` — Administration → API and webhooks.
   Without it EPM still works, it just learns about upstream changes on its own
   schedule.

Then `up -d` again to pick them up. Reaching OpenProject's own UI while only 443
is open means tunnelling to it, since it is deliberately not published:

```bash
ssh -L 8080:localhost:8080 user@host
docker run --rm -d --network epm_epm -p 8080:80 alpine/socat tcp-listen:80,fork tcp:openproject:80
```

Approvals need the governance types — Change Request and Risk, the Pending
approval, Approved and Rejected statuses, and the Change value field that
approval thresholds read. A fresh OpenProject has none of them. The script that
creates them is in the `epm-openproject` image; it creates only what is missing,
so running it again is harmless:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env.prod exec -T openproject \
  bundle exec rails runner /app/epm-setup/governance-types.rb
```

Then define the chains themselves in EPM, under Administration → Work packages →
Approval chains.

Rules act as an account of their own, not as anyone's. Create it once — the
script is in the same image — and put the key it prints in `.env.prod`:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env.prod exec -T openproject   bundle exec rails runner /app/epm-setup/automation-account.rb
```

The account, "EPM Automation", is not an administrator: EPM makes it a member of
a project, with its own minimal role, the first time a rule acts there. Its key
is printed once (`ROTATE=1` issues a new one). Set it as
`OPENPROJECT_AUTOMATION_API_KEY`, or put it in a file and set
`OPENPROJECT_AUTOMATION_API_KEY_FILE` — EPM's own secrets (the OpenProject keys
and OAuth secret, the webhook secrets, `SESSION_SECRET`, the mail credentials, `EPM_ANALYTICS_DATABASE_URL`,
`EPM_OPS_ALERT_WEBHOOK_URL`, `EPM_METRICS_TOKEN`) can each be read from a file
named by `<NAME>_FILE`, which is how a secret store hands them over. Two
exceptions: `DATABASE_URL`, which Prisma and the migration step read from the
environment themselves (the compose file builds it from `POSTGRES_PASSWORD`),
and AWS credentials, which come from the AWS chain (a task role, or
`AWS_SHARED_CREDENTIALS_FILE`) — then `up -d`. Until it is set, rules notify and call out but change nothing in
OpenProject, and approval outcomes are moved with the service key.

For rules to see changes made in OpenProject itself, its webhook (Administration
→ API and webhooks) has to send the work package and project events, created
and updated, to `https://<host>/api/webhooks/openproject`, signed with
`OPENPROJECT_WEBHOOK_SECRET`. Changes made through EPM reach the rules either
way. Rules and escalation policies are defined in EPM, under Administration →
Rules and escalation.

## Critical path

EPM computes the critical path and the float of every scheduled work package
itself, over the whole network at once, and keeps them in its own database:
the Gantt's critical path view, each task's Schedule card and the API read
them there. It recalculates soon after any change made through EPM, and its
check — every `EPM_SCHEDULE_CHECK_SECONDS` — catches changes made in
OpenProject itself, a holiday added to its calendar included. Nothing needs
starting. `GET /api/schedule/status` reports the last pass: how big the network
was and how long each step took.

It also writes the figures into three work package fields — Total float
(days), Free float (days) and On critical path — so saved views can show,
filter, group and sum them. Create the fields once; the script is in the
`epm-openproject` image and creates only what is missing:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env.prod exec -T openproject \
  bundle exec rails runner /app/epm-setup/schedule-fields.rb
```

Run it again after adding a work package type, so the new type holds the fields
too. Until it has run, the figures are shown everywhere in EPM and the fields
simply do not exist; the status reports why. The values are written by
`zzz_epm_schedule.rb` straight into the fields and kept out of the journal: a
float moving because another task's date moved is not an edit, and no one's
Activity shows it as one.

A read waits for a pending recalculation while the network is at most
`EPM_SCHEDULE_SYNC_LIMIT` work packages (500 by default), so what a person sees
reflects the change they just made; above that it answers at once and says the
figures are being recalculated. A change never waits. Near-critical means total
float of at most `EPM_SCHEDULE_NEAR_CRITICAL_DAYS` working days unless a view
chooses otherwise. `EPM_SCHEDULE_MIRROR_ENABLED=false` keeps the figures in EPM
only.

## Earned value

EPM computes earned value itself — Insights → Earned value, each task's Earned
value card, `GET /api/earned-value` — and adds nothing to OpenProject. Nothing
needs starting. A work package's budget is its estimate at its assignee's
hourly rate, so people need rates (Employees); work with no assignee or no rate
is priced at the rate for unpriced work, if one is set, and otherwise left out
and counted. That rate and each work package type's earning rule are set under
Administration → Projects → Earned value; until rules are saved, every type
earns by % complete. Changing them needs the `evm:configure` permission, which
the administrators in `EPM_ADMIN_USER_IDS` hold and the Permissions page can
grant.

A project is measured against its latest baseline once one is set, from its
Earned value dashboard by anyone who may edit the project. A baseline cannot be
changed afterwards — the database refuses — and goes with its project.

The figures period by period are rewritten into `analytics.fact_evm_period` after
the nightly full analytics refresh and the first refresh of each day: by week and
by month, for the instance, every portfolio and every project. The analytics
role reads it like the rest of the schema. `analytics.dim_date.is_working_day`
holds OpenProject's working calendar.

## Analytics

Reports and dashboards read EPM's analytics model, a schema of its own
(`analytics`) that the backend loads from OpenProject and refreshes by itself:
soon after each change, every 10 minutes regardless, and in full each night at
`EPM_ANALYTICS_FULL_REFRESH_HOUR_UTC`, when every table is reconciled against
its source. Nothing needs starting. Administration → Analytics model shows each
refresh, how long it took against `EPM_ANALYTICS_REFRESH_WINDOW_MINUTES`, how it
reconciled, and the daily capture that history is checked against.

The model reads work package history through `zzz_epm_analytics_api.rb`, in the
`epm-openproject` image. It is read-only.

### Analytics replica

BI tools read a streaming replica of the EPM database rather than the primary,
as a read-only role that can see the analytics schema and nothing else (BR-401).
It is optional, and started with the `analytics` profile. Once, before the first
start, set `EPM_REPLICATION_PASSWORD` and `EPM_ANALYTICS_DB_PASSWORD` in
`.env.prod`, then create the two accounts from the backend:

```bash
set -a; . ./.env.prod; set +a
docker compose -f docker-compose.deploy.yml --env-file .env.prod exec -T \
  -e EPM_REPLICATION_PASSWORD="$EPM_REPLICATION_PASSWORD" backend \
  node dist/scripts/analytics.js replication epm_analytics_replica
docker compose -f docker-compose.deploy.yml --env-file .env.prod exec -T \
  -e EPM_ANALYTICS_DB_PASSWORD="$EPM_ANALYTICS_DB_PASSWORD" backend \
  node dist/scripts/analytics.js role
docker compose -f docker-compose.deploy.yml --env-file .env.prod --profile analytics up -d postgres-replica
```

The first creates the replication account and a replication slot, and caps the
WAL a slot may hold at 4 GB (`max_slot_wal_keep_size`), so a replica that is gone
for good costs the primary at most that. The second creates `epm_analytics`:
it may read every table and function in the analytics schema, may not write
anything, and may not read any application table. The replica clones the primary
on its first start and follows it from then on.

Who connects where is decided in the compose file. The primary refuses the
analytics role outright, so reporting can never land on it; the replica accepts
only that role, only from `EPM_ANALYTICS_ALLOWED_CIDR` (default: the Docker
networks it is on), on `EPM_ANALYTICS_BIND:EPM_ANALYTICS_PORT` (default
`127.0.0.1:5434`, so over an SSH tunnel). Name the analytics estate's address
range and interface there to open it to BI tools.

Set `EPM_ANALYTICS_DATABASE_URL` to the role on the replica, and Administration
→ Analytics model → Access will confirm that it reads every table and that each
kind of write is refused, by the replica and by the role's grants separately.

Wiping the replica's volume means cloning again; the slot is reused. Retiring
the replica for good means dropping the slot on the primary:
`SELECT pg_drop_replication_slot('epm_analytics_replica');`.

## Scheduled reports

Scheduled reports (Insights → Scheduled reports) are built per recipient, each
with that person's own access, and sent through the email outbox — so they go
out only where email does: SMTP or Resend configured and the email worker on.
A send that fails is retried; one that still fails after its retries is not
dropped. Operations are told in-app (`EPM_OPS_ALERT_USER_IDS`, else the
administrators), in the journal, in the log as an error-level line carrying
`alert`, and, when `EPM_OPS_ALERT_WEBHOOK_URL` is set, by a JSON POST to it.

Due reports are looked for every `EPM_REPORT_SCHEDULER_SECONDS`. An occurrence
the server was down for is still sent if it comes back within the schedule's
window, and is logged as missed after that rather than sent at the wrong time.
The run log is kept for `EPM_REPORT_RUN_RETENTION_DAYS` (seven years by default)
and the files each run sent for `EPM_REPORT_ARTIFACT_RETENTION_DAYS`; both are
pruned once a day.

Defining reports and reading their log needs `reports:schedule`; approving an
outside address needs `reports:approve`, held by someone other than whoever
added it. Both are EPM permissions: the administrators in `EPM_ADMIN_USER_IDS`
hold them; anyone else needs a row in `epm_permission_grants` (OpenProject user
id, permission) until roles can grant them.

## What is in each image

| Image | Contents |
|---|---|
| `epm-backend` | `dist`, production modules, the generated Prisma client, the Prisma CLI for migrations |
| `epm-web` | the built bundle plus Caddy and the Caddyfile; no domain baked in |
| `epm-openproject` | `openproject/openproject:15` plus the six EPM initializers and the setup scripts (governance types, automation account, schedule fields) |
| `postgres:17-alpine` | pulled from the official library, nothing of ours in it |

`epm-openproject` exists because EPM cannot use a stock OpenProject: sign-in
depends on `zzz_epm_password_grant.rb` being loaded inside that container, and
the other five add the administrative endpoints EPM reads, the history its
analytics model loads and the bridge its critical path pass reads and writes
through. They
used to be bind-mounted from a checkout, which made the host depend on this
repository being present at the right commit — and a stack that comes up with
the mount missing starts cleanly and then refuses every sign-in. Baked into the
image, they travel with the tag.

`epm-web` carries no domain because `src/config/env.ts` resolves the API to the
relative path `/api` in production, which the browser takes as the origin that
served the page; Caddy proxies `/api` there to the backend. So one image runs on
staging and production both, and moving domains is an environment change rather
than a rebuild. `VITE_API_BASE_URL` remains a build argument for the one case a
relative path cannot express — a backend on a different origin — and setting it
ties that image to that address.

## Data

| What | Where |
|---|---|
| OpenProject database and attachments | bind mount at `OPENPROJECT_DATA_DIR`, default `/srv/openproject` |
| EPM database | named volume `epm-pgdata` |
| Analytics replica | named volume `epm-pgdata-replica`; a copy, rebuilt by cloning |
| TLS certificates | named volume `caddy-data` |

OpenProject's data is a bind mount on purpose: a path can be pointed at a
mounted disk, and a mounted disk can be snapshotted independently of the
instance. `caddy-data` must survive a recreate — without it Caddy re-issues on
every deploy and will meet Let's Encrypt's rate limit.

Backups are taken by `deploy/backup/epm-backup.sh` — EPM's database,
OpenProject's database and its attachments, with checksums, a manifest and
optional encryption and off-host copy — and put back by `epm-restore.sh`. The
schedule, the recovery objectives, the restore test and the runbook are in
`deploy/backup/README.md`.

## Monitoring

`/metrics` serves health, latency and error figures in the Prometheus format once
`EPM_METRICS_TOKEN` is set; it is not routed by Caddy, so the scraper reaches the
backend on the internal network. Alert rules and the scrape configuration are in
`deploy/monitoring/`.
