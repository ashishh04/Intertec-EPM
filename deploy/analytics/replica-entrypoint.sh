#!/bin/sh
# EPM analytics replica (BR-401): a streaming, read-only copy of EPM's database
# for reporting, so a BI tool never competes with people for the primary.
#
# On first start, with an empty data directory, it clones the primary with
# pg_basebackup and sets itself up as a standby that follows it (-R); after
# that it just starts, and streaming resumes on its own. A hot standby refuses
# every write: the first of two locks, the analytics role's grants the second.
#
# Who may connect is decided here, not copied from the primary: the analytics
# role from ANALYTICS_ALLOWED_CIDR (default: the networks the container is on),
# and the local socket for health checks. Everything else is refused.
#
# Environment: PRIMARY_HOST, REPLICATION_USER, REPLICATION_PASSWORD, and
# optionally REPLICATION_SLOT (created on the primary by
# `npm run analytics -- replication`), ANALYTICS_ROLE, ANALYTICS_ALLOWED_CIDR.
#
# docker-compose.deploy.yml carries this same script inline, because the deploy
# host has no checkout; domain/__checks__/analytics.check.ts keeps the two equal.
set -eu
HBA=/var/lib/postgresql/epm_replica_hba.conf
printf 'local all all trust\nhost all %s %s scram-sha-256\nhost all all all reject\n' \
  "${ANALYTICS_ROLE:-epm_analytics}" "${ANALYTICS_ALLOWED_CIDR:-samenet}" > "$HBA"
chown postgres:postgres "$HBA"
chmod 600 "$HBA"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until pg_isready -q -h "$PRIMARY_HOST"; do echo "analytics replica: waiting for $PRIMARY_HOST"; sleep 2; done
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  gosu postgres env PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup -h "$PRIMARY_HOST" -U "$REPLICATION_USER" \
    -D "$PGDATA" -X stream -R -c fast ${REPLICATION_SLOT:+-S "$REPLICATION_SLOT"}
fi
exec gosu postgres postgres -c hot_standby=on -c hba_file="$HBA" -c listen_addresses='*'
