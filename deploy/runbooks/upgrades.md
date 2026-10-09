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
