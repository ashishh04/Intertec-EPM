# OpenProject with the EPM initializers built in.
#
# Why this image exists rather than bind mounts
# ---------------------------------------------
# EPM cannot run against a stock OpenProject. It signs people in on its own form
# and exchanges their credentials for an OpenProject token, which needs
# zzz_epm_password_grant.rb loaded inside the container; the other three add the
# administrative endpoints EPM reads.
#
# Mounted from a working copy, those four files make the deployment host depend
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

FROM openproject/openproject:15

COPY zzz_epm_password_grant.rb  /app/config/initializers/zzz_epm_password_grant.rb
COPY zzz_epm_admin_api.rb       /app/config/initializers/zzz_epm_admin_api.rb
COPY zzz_epm_admin_settings.rb  /app/config/initializers/zzz_epm_admin_settings.rb
COPY zzz_epm_admin_catalog.rb   /app/config/initializers/zzz_epm_admin_catalog.rb
