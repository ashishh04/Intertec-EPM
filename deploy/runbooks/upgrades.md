# Runbook: upgrades (NFR14)

`dc` means `docker compose -f docker-compose.deploy.yml --env-file .env.prod`.

## EPM release

1. Read the release notes for migrations and new settings (`.env.prod.example` diff).
2. Take a backup: `sh deploy/backup/epm-backup.sh` (a migration cannot be undone by changing the tag).
3. Set `EPM_IMAGE_TAG` to the new version in `.env.prod`; `dc pull && dc up -d`. The backend applies
   pending migrations on start (`prisma migrate deploy`), and only ever moves forward.
4. Verify: `/ready` is 200; sign in; open a project; Administration → Audit journal shows recent
   entries; `/metrics` scrapes.
5. Roll back if needed: previous tag, `dc pull && dc up -d`; restore the backup only if the release
   migrated the database.

## Base images and patches

Dependabot raises digest updates weekly; they arrive in a normal release. A critical one follows the
out-of-band path in the vulnerability and patch process.

## OpenProject

OpenProject supports only its latest major release with security fixes, so EPM must move with it.
EPM's initializers use OpenProject's internal APIs (`backend/openproject/README.md`), so every
upgrade — minor too — is rehearsed:

1. On staging, with a copy of production data (restore a recent backup there).
2. Change the `FROM` in `backend/openproject/Dockerfile` (tag and digest), build in CI.
3. Start it; OpenProject migrates its database on first start (a major can take many minutes).
4. Check, in order: sign-in through EPM (the password-grant initializer); the administration pages
   (admin API initializers); Administration → Analytics, a full refresh (the analytics history
   initializer); a critical-path recalculation on a project (the scheduling initializer); a
   document filed before the upgrade still opens (the library's files are attachments with no
   container, kept from OpenProject's nightly cleanup by `OPENPROJECT_ATTACHMENTS__GRACE__PERIOD`
   in `backend/openproject/Dockerfile`); the authorisation suite against staging.
5. Only then production: backup, deploy the new image, verify as for a release.
6. A major upgrade is not reversible by changing the tag: OpenProject's database has been migrated.
   The way back is the backup taken in step 5.

The 15.5.1 → 17.9.2 upgrade (October 2026) is written up step by step in
`backend/openproject/README.md`: one major at a time, Postgres 15 or newer, and `SECRET_KEY_BASE`.

## Moving OpenProject off its bundled database (once per server)

From October 2026 OpenProject's database is its own service, `openproject-db`, in both compose
files; the image's bundled Postgres stays off because `DATABASE_URL` names another host. A server
installed before that keeps its database in `$OPENPROJECT_DATA_DIR/pgdata`, and moves once. Do
the OpenProject upgrade first if it is due: the bundled database must be on Postgres 17, the
version of `openproject-db`.

1. Set `OPENPROJECT_DB_PASSWORD` in `.env.prod` (`openssl rand -hex 24`: hex, as it goes into a URL).
2. Stop EPM and OpenProject: `docker compose -f docker-compose.deploy.yml --env-file .env.prod stop backend web openproject`.
3. Dump the bundled database with the old container's own tools, starting only its Postgres:
   `docker compose ... run --rm --no-deps -T --entrypoint sh openproject -c 'su postgres -c "/usr/lib/postgresql/17/bin/pg_ctl -D /var/openproject/pgdata -w start" && su postgres -c "pg_dump -d openproject -Fc"' > openproject.dump`
   — run this with the *previous* compose file, which still mounts `pgdata`.
4. With the new compose file: `docker compose ... up -d openproject-db`, then restore:
   `docker compose ... exec -T openproject-db pg_restore -U openproject -d openproject --no-owner --role=openproject --exit-on-error < openproject.dump`.
5. Compare counts of `work_packages`, `users`, `attachments` and `journals` between the dump's
   source and `openproject-db`; they must be equal.
6. `docker compose ... up -d`; OpenProject starts on `openproject-db` (`pgrep postgres` inside the
   `openproject` container finds nothing). Verify as for a release.
7. Keep `$OPENPROJECT_DATA_DIR/pgdata` until the next backup has been taken and checked, then remove it.

Rehearsed on the development instance on 19 Oct 2026 (960 work packages, 14 users, 7 attachments,
1,270 journals and 3,779 custom values, equal before and after; EPM's checks passed after).
