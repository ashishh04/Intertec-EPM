#!/usr/bin/env sh
# EPM restore (NFR13): puts back what epm-backup.sh took.
#
#   sh epm-restore.sh /srv/epm-backups/20261009T020000Z --yes [--only epm|openproject|assets]
#
# DESTRUCTIVE: the current EPM database, OpenProject database and attachments
# are replaced by the backup's. Without --yes it only checks the backup and
# says what it would do.
#
# Order of work, and why:
#   1. Check every file against SHA256SUMS (decrypting first if the backup is
#      encrypted; the private key must be on this host for that).
#   2. Stop EPM's backend and web, so nothing writes while data is replaced.
#   3. EPM's database: dropped and recreated, then restored from epm.dump.
#      The analytics replica follows on its own; the append-only journal's
#      triggers are restored with the schema.
#   4. OpenProject: its container is stopped; its own database service
#      (openproject-db) gets a recreated database restored from
#      openproject.dump; the attachments directory is replaced from the tar.
#      Then OpenProject starts.
#   5. EPM's backend and web start again, and /ready is checked.
#
# Settings: COMPOSE_FILE, ENV_FILE as for epm-backup.sh.
#
# Rehearsed (deploy/backup/README.md, "Restore test"): the EPM database restore
# end to end, and the OpenProject database and attachments restored into a
# scratch PostgreSQL and directory with their contents verified. The in-place
# OpenProject step (4) restarts the shared instance, so it is rehearsed on
# staging before anyone relies on it in production.

set -eu

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.deploy.yml}
ENV_FILE=${ENV_FILE:-.env.prod}

SOURCE=${1:-}
[ -n "$SOURCE" ] && [ -d "$SOURCE" ] || { echo "usage: epm-restore.sh <backup directory> [--yes] [--only epm|openproject|assets]" >&2; exit 2; }
shift
CONFIRMED=no
ONLY=all
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) CONFIRMED=yes ;;
    --only) shift; ONLY=${1:-} ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
say() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
wants() { [ "$ONLY" = all ] || [ "$ONLY" = "$1" ]; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

say "Checking $SOURCE"
(cd "$SOURCE" && sha256sum -c SHA256SUMS)
for file in epm.dump openproject.dump openproject-assets.tar.gz; do
  if [ -f "$SOURCE/$file.gpg" ]; then
    gpg --batch --yes --output "$WORK/$file" --decrypt "$SOURCE/$file.gpg"
  else
    cp "$SOURCE/$file" "$WORK/$file"
  fi
done
cat "$SOURCE/MANIFEST"

if [ "$CONFIRMED" != yes ]; then
  say "Backup is intact. Nothing was changed: run again with --yes to restore ($ONLY)."
  exit 0
fi

say "Stopping EPM (backend, web)"
compose stop backend web

if wants epm; then
  say "Restoring EPM's database"
  compose exec -T postgres sh -c 'dropdb -U "${POSTGRES_USER:-epm}" --if-exists --force "${POSTGRES_DB:-epm}" && createdb -U "${POSTGRES_USER:-epm}" "${POSTGRES_DB:-epm}"'
  compose exec -T postgres sh -c 'pg_restore -U "${POSTGRES_USER:-epm}" -d "${POSTGRES_DB:-epm}" --no-owner --exit-on-error' < "$WORK/epm.dump"
fi

if wants openproject || wants assets; then
  say "Stopping OpenProject"
  compose stop openproject
fi

if wants openproject; then
  say "Restoring OpenProject's database (its own service, openproject-db)"
  compose up -d openproject-db
  for attempt in $(seq 1 30); do
    compose exec -T openproject-db pg_isready -U openproject -d postgres >/dev/null 2>&1 && break
    sleep 2
  done
  compose exec -T openproject-db sh -c 'dropdb -U openproject --if-exists --force openproject && createdb -U openproject openproject'
  compose exec -T openproject-db pg_restore -U openproject -d openproject --no-owner --role=openproject --exit-on-error < "$WORK/openproject.dump"
fi

if wants assets; then
  say "Restoring OpenProject's attachments"
  compose run --rm --no-deps -T --entrypoint sh openproject -c '
    set -e
    rm -rf /var/openproject/assets.restoring && mkdir -p /var/openproject/assets.restoring
    tar -C /var/openproject/assets.restoring -xzf -
    rm -rf /var/openproject/assets.previous
    mv /var/openproject/assets /var/openproject/assets.previous 2>/dev/null || true
    mv /var/openproject/assets.restoring/assets /var/openproject/assets
    rm -rf /var/openproject/assets.restoring
  ' < "$WORK/openproject-assets.tar.gz"
fi

if wants openproject || wants assets; then
  say "Starting OpenProject (its first start after a restore takes a minute or two)"
  compose up -d openproject
fi

say "Starting EPM"
compose up -d backend web

say "Waiting for EPM to be ready"
for attempt in $(seq 1 60); do
  if compose exec -T backend node -e "fetch('http://localhost:8000/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null; then
    say "Restored from $SOURCE, and EPM is ready."
    exit 0
  fi
  sleep 5
done
say "EPM did not report ready within five minutes: check 'docker compose logs backend openproject'."
exit 1
