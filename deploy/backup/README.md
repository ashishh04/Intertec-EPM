# Backup and restore (NFR13, NFR14)

Two scripts, run on the deployment host from the directory that holds `docker-compose.deploy.yml`
and `.env.prod`.

| Script | Does |
| --- | --- |
| `epm-backup.sh` | Dumps EPM's database and OpenProject's database (custom format), tars OpenProject's attachments, checks the dumps are readable, writes a manifest (versions, row counts, sizes) and SHA-256 checksums. Optional encryption and off-host copy. Removes runs older than the retention. |
| `epm-restore.sh <run> [--yes] [--only epm\|openproject\|assets]` | Verifies the checksums; with `--yes`, stops EPM, restores what was asked, restarts and waits for `/ready`. Without `--yes` it only verifies. |

What is deliberately not in a backup: the analytics replica (rebuilt by cloning, DEPLOY.md),
Caddy's certificates (re-issued on start) and `.env.prod` — secrets live in the secret store and
are backed up there, never next to the data.

## Scheduling

Daily, at a quiet hour, as root or a user in the `docker` group:

```cron
# /etc/cron.d/epm-backup — 02:15 UTC every day
15 2 * * * epm cd /srv/epm && BACKUP_ROOT=/srv/epm-backups RETENTION_DAYS=14 \
  BACKUP_GPG_RECIPIENT=backups@example.org \
  BACKUP_COPY_COMMAND='aws s3 cp --recursive "$1" "s3://example-epm-backups/$(basename "$1")/"' \
  sh deploy/backup/epm-backup.sh >> /var/log/epm-backup.log 2>&1
```

- **Off the host.** A backup on the same disk as the data is not a backup. `BACKUP_COPY_COMMAND`
  receives the finished run's directory; point it at object storage or another site in the
  designated jurisdiction (NFR09).
- **Encrypted.** Set `BACKUP_GPG_RECIPIENT` to a key whose private half is *not* on the host;
  keep the private key in the secret store, and test that it decrypts (the restore test does).
- **Watched.** A failed run exits non-zero and leaves only a `.partial` directory. Alert on the
  log, or on the age of the newest run directory (a day and a half is the threshold to use).

## Recovery objectives — proposed

| Objective | Proposed | Basis |
| --- | --- | --- |
| RPO (data that may be lost) | 24 hours | One backup a day. Halve it by running twice a day; under an hour needs continuous WAL archiving of both databases, not a script. |
| RTO (time to restore service) | 4 hours | A new host from images (DEPLOY.md, under an hour), plus the restore. The restore of today's data took minutes in the restore test below; the objective leaves room for a database a hundred times larger and for verification. |

Both are to be agreed with the client; the recorded restore test is the evidence for the RTO.

## Restore test

Run at least quarterly, and after any change to these scripts, on a copy — never on production:

1. Take a backup with `epm-backup.sh`.
2. Restore EPM's dump into a scratch database (`createdb epm_restore_check`, `pg_restore --no-owner
   -d epm_restore_check`) and compare its row counts with the manifest and the source.
3. Restore OpenProject's dump into a scratch PostgreSQL container of the same major version and
   compare `work_packages`, `users` and `attachments` with the manifest.
4. Untar the attachments into a scratch directory and compare the file count.
5. If the backup is encrypted, decrypt with the key from the secret store — this is what proves
   the key works.
6. Record the date, the sizes, the counts compared and the time each step took. Remove the
   scratch database, container and directory.

The full in-place procedure (`epm-restore.sh --yes`) is rehearsed on staging, since it stops and
restarts OpenProject.

**19 Oct 2026, development instance, after OpenProject moved to its own database (`openproject-db`):**
`epm-backup.sh` run against the local containers (`EPM_DB=container:epm-postgres
OPENPROJECT=container:openproject OPENPROJECT_DB=container:openproject-db`): EPM 1.3 MB,
OpenProject 8.8 MB, attachments 0.9 MB, checksums verified. OpenProject's dump restored into a
scratch database in `openproject-db`: 960 work packages, 14 users, 7 attachments, 1,270 journals and
3,779 custom values, equal to the source; scratch database dropped. The in-place step was rehearsed
the same day by the move itself — the live instance's dump restored into a new `openproject-db` and
OpenProject started on it, counts equal, EPM's checks passing.

## Runbook: restoring production

1. Decide what to restore and from which run (`ls /srv/epm-backups`). Tell users the system is
   going down.
2. `sh deploy/backup/epm-restore.sh /srv/epm-backups/<run>` — verifies the checksums and prints the
   manifest. Check the versions in the manifest match the images now deployed; if OpenProject's
   version differs, deploy the image the backup was taken with first.
3. `sh deploy/backup/epm-restore.sh /srv/epm-backups/<run> --yes` — stops EPM, restores, restarts,
   waits for `/ready`.
4. Sign in, open a project, open a document. Check the journal's latest entries match the backup
   time (Administration → Audit journal).
5. Changes made after the backup are gone: tell the people affected. Record the incident.
