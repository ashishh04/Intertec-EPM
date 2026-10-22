# OpenProject with the EPM initializers built in.
#
# Why this image exists rather than bind mounts
# ---------------------------------------------
# EPM cannot run against a stock OpenProject. It signs people in on its own form
# and exchanges their credentials for an OpenProject token, which needs
# zzz_epm_password_grant.rb loaded inside the container; the other eight add the
# administrative endpoints EPM reads, the history its analytics model loads, the
# bridge its critical path pass reads and writes through, the one its
# calculated fields do, and the cost entries approved expense claims become.
#
# Mounted from a working copy, those nine files make the deployment host depend
# on a checkout of this repository being present, at the right commit, at the
# right path. A stack that comes up with the mount missing starts cleanly and
# then refuses every sign-in, with nothing in any log that points at the cause.
# Baked into an image they travel with the tag, and the host needs a compose file
# and an env file and nothing else.
#
# No USER directive, deliberately
# -------------------------------
# COPY is performed by the builder and always writes root-owned, world-readable
# files, whatever USER is in effect — so the initializers land readable by the
# unprivileged user the upstream image runs as, and that user is left exactly as
# upstream set it. Switching to root here to adjust ownership would mean naming
# the account to switch back to, which is upstream's business and has changed
# between their releases.
#
# Upgrade implications
# --------------------
# These initializers reconfigure Doorkeeper and call `User.try_to_login`, both
# internal OpenProject APIs. After changing the base tag below, verify sign-in
# still works before calling the upgrade done — see README.md in this directory.
#
# Pinned by digest to the build EPM is tested against: 17.9.2, the current
# release (upgraded from 15.5.1 in October 2026, which no longer received
# security fixes). It still bundles PostgreSQL 13 beside 17 and keeps running on
# an existing 13 data directory; moving that to 17 is a separate step
# (/app/docker/prod/postgres-db-upgrade). Upgrades follow the vulnerability and
# patch process.

FROM openproject/openproject:17.9.2@sha256:3603f071443e16f773ca0e6bbe7f12f66eeeb95cca4540c4f93ec504305a0596

# Library documents are kept
# --------------------------
# EPM's document library stores each file as an attachment with no container
# (backend/src/routes/documents.ts says why). OpenProject takes those for
# abandoned uploads: Attachments::CleanupUncontaineredJob runs nightly at 22:03
# UTC and destroys every one older than this grace period, 180 minutes unless
# set. A document filed in the morning would be gone by the next day. A hundred
# years, in minutes, means that job deletes nothing EPM stored. Set in the image
# rather than the env file because the library depends on it everywhere.
ENV OPENPROJECT_ATTACHMENTS__GRACE__PERIOD=52560000

COPY zzz_epm_password_grant.rb  /app/config/initializers/zzz_epm_password_grant.rb
COPY zzz_epm_admin_api.rb       /app/config/initializers/zzz_epm_admin_api.rb
COPY zzz_epm_admin_settings.rb  /app/config/initializers/zzz_epm_admin_settings.rb
COPY zzz_epm_admin_catalog.rb   /app/config/initializers/zzz_epm_admin_catalog.rb
COPY zzz_epm_analytics_api.rb   /app/config/initializers/zzz_epm_analytics_api.rb
COPY zzz_epm_schedule.rb        /app/config/initializers/zzz_epm_schedule.rb
COPY zzz_epm_calculated.rb      /app/config/initializers/zzz_epm_calculated.rb
COPY zzz_epm_costs.rb           /app/config/initializers/zzz_epm_costs.rb
COPY zzz_epm_service.rb         /app/config/initializers/zzz_epm_service.rb

# Configuration scripts, run on demand rather than at boot — the governance
# types (Change Request, Risk) the approval chains and health rules use, the
# automation account rules act as, and the fields EPM writes float into:
#   docker compose exec -T openproject bundle exec rails runner /app/epm-setup/governance-types.rb
#   docker compose exec -T openproject bundle exec rails runner /app/epm-setup/automation-account.rb
#   docker compose exec -T openproject bundle exec rails runner /app/epm-setup/schedule-fields.rb
# They write OpenProject's own records through its own models, the way an
# administrator would, and patch nothing.
COPY setup/ /app/epm-setup/
