#!/usr/bin/env sh
# EPM backup (NFR13): everything a deployment needs to be put back.
#
#   EPM's database             pg_dump, custom format       epm.dump
#   OpenProject's database     pg_dump in openproject-db    openproject.dump
#   OpenProject's attachments  tar of /var/openproject/assets  openproject-assets.tar.gz
#   What was backed up         versions, sizes, row counts  MANIFEST
#   Checksums of all of it                                  SHA256SUMS
#
# Not here, on purpose: the analytics replica (rebuilt by cloning, DEPLOY.md),
# Caddy's certificates (re-issued on start), and .env.prod — secrets belong in
# the secret store and its own backups, never next to the data.
#
# Run on the deployment host, from the directory holding the compose file:
#
#   sh epm-backup.sh
#
# Settings (environment):
#   COMPOSE_FILE       default docker-compose.deploy.yml
#   ENV_FILE           default .env.prod
#   BACKUP_ROOT        default /srv/epm-backups; each run is one dated directory
#   RETENTION_DAYS     default 14; older run directories are removed
#   BACKUP_GPG_RECIPIENT  encrypt every file to this key (recommended off-host)
#   BACKUP_COPY_COMMAND   run with the run's directory as $1 once it is
#                         complete, e.g. 'aws s3 cp --recursive "$1" s3://bucket/epm/'
#   EPM_DB, OPENPROJECT, OPENPROJECT_DB
#                         compose service names (default postgres, openproject,
#                         openproject-db), or container:<name> to address a
#                         container directly
#
# Exit status is non-zero on any failure, and a failed run leaves only a
# `.partial` directory, never something that looks like a good backup.
# Schedule it daily (cron or a systemd timer); see deploy/backup/README.md.

set -eu

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.deploy.yml}
ENV_FILE=${ENV_FILE:-.env.prod}
BACKUP_ROOT=${BACKUP_ROOT:-/srv/epm-backups}
RETENTION_DAYS=${RETENTION_DAYS:-14}
EPM_DB=${EPM_DB:-postgres}
OPENPROJECT=${OPENPROJECT:-openproject}
OPENPROJECT_DB=${OPENPROJECT_DB:-openproject-db}

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$BACKUP_ROOT/$STAMP"
WORK="$DEST.partial"

# Runs a command in a compose service, or in a named container.
in_service() {
  target=$1
  shift
  case "$target" in
    container:*) docker exec -i "${target#container:}" "$@" ;;
    *) docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T "$target" "$@" ;;
  esac
}

say() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }

mkdir -p "$WORK"
say "Backing up to $DEST"

say "EPM database"
in_service "$EPM_DB" sh -c 'pg_dump -U "${POSTGRES_USER:-epm}" -d "${POSTGRES_DB:-epm}" -Fc' > "$WORK/epm.dump"

say "OpenProject database"
in_service "$OPENPROJECT_DB" pg_dump -U openproject -d openproject -Fc > "$WORK/openproject.dump"

say "OpenProject attachments"
in_service "$OPENPROJECT" tar -C /var/openproject -czf - assets > "$WORK/openproject-assets.tar.gz"

# A dump that pg_restore cannot list is not a backup. Checked here, with the
# same tools a restore will use, rather than discovered during one.
say "Checking the dumps can be read"
in_service "$EPM_DB" pg_restore -l < "$WORK/epm.dump" > /dev/null
in_service "$OPENPROJECT_DB" pg_restore -l < "$WORK/openproject.dump" > /dev/null
tar -tzf "$WORK/openproject-assets.tar.gz" > /dev/null

say "Manifest"
{
  echo "created_utc=$STAMP"
  echo "epm_migration=$(in_service "$EPM_DB" sh -c 'psql -U "${POSTGRES_USER:-epm}" -d "${POSTGRES_DB:-epm}" -Atc "select migration_name from _prisma_migrations order by finished_at desc nulls last limit 1"')"
  echo "epm_audit_events=$(in_service "$EPM_DB" sh -c 'psql -U "${POSTGRES_USER:-epm}" -d "${POSTGRES_DB:-epm}" -Atc "select count(*) from audit_events"')"
  echo "openproject_version=$(in_service "$OPENPROJECT" sh -c "awk '/MAJOR =|MINOR =|PATCH =/{print \$3}' /app/lib/open_project/version.rb | paste -sd. -")"
  echo "openproject_work_packages=$(in_service "$OPENPROJECT_DB" psql -U openproject -d openproject -Atc "select count(*) from work_packages")"
  echo "openproject_users=$(in_service "$OPENPROJECT_DB" psql -U openproject -d openproject -Atc "select count(*) from users")"
  echo "openproject_attachments=$(in_service "$OPENPROJECT_DB" psql -U openproject -d openproject -Atc "select count(*) from attachments")"
  for file in epm.dump openproject.dump openproject-assets.tar.gz; do
    echo "size_bytes_$file=$(wc -c < "$WORK/$file" | tr -d ' ')"
  done
} > "$WORK/MANIFEST"

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  say "Encrypting to $BACKUP_GPG_RECIPIENT"
  for file in epm.dump openproject.dump openproject-assets.tar.gz; do
    gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" \
      --output "$WORK/$file.gpg" --encrypt "$WORK/$file"
    rm -f "$WORK/$file"
  done
fi

say "Checksums"
(cd "$WORK" && sha256sum -- * > SHA256SUMS)

mv "$WORK" "$DEST"
say "Complete: $DEST"

if [ -n "${BACKUP_COPY_COMMAND:-}" ]; then
  say "Copying off the host"
  sh -c "$BACKUP_COPY_COMMAND" copy "$DEST"
fi

# Retention: whole dated run directories only, and never the one just made.
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime +"$RETENTION_DAYS" \
  ! -path "$DEST" -exec rm -rf {} +
say "Kept the last $RETENTION_DAYS days in $BACKUP_ROOT"
