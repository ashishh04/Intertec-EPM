# EPM backend.
#
# Two stages, so the runtime image carries no TypeScript, no source and no dev
# dependencies — only `dist`, the production modules and the Prisma client.
#
# The Prisma client is generated in the build stage and copied forward: it is
# platform-specific native code, so generating it anywhere other than the image
# it runs in produces a binary the runtime cannot load.
#
# Two things worth knowing before editing:
#
# The Prisma CLI is a production dependency, not a dev one, because the
# entrypoint runs `prisma migrate deploy`. As a dev dependency it was removed by
# `npm prune` and `npx` would then try to fetch it from the registry on every
# container start — a boot that needs the npm registry to be reachable is a boot
# that fails on a locked-down host, and fails at the worst time.
#
# The build runs `build:image` rather than `build`. `build` first runs
# `types:check`, which reads frontend/src/types/index.ts from the repository
# root to prove the two copies of the domain models agree. That path does not
# exist inside a build context rooted at ./backend, so it fails here. The check
# belongs where both directories are present — it runs in CI before the image is
# built, see .github/workflows/release.yml.

# ---------------------------------------------------------------- build
FROM node:22-slim AS build

WORKDIR /app

# Prisma's postinstall needs the schema present, so it is copied with the
# manifests rather than with the rest of the source.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build:image

# Drop everything the runtime will not use. Done here rather than by copying
# selectively below, so the layer that ships is the one that was tested.
RUN npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:22-slim AS runtime

# libssl3 and the CA bundle, neither of which is in the slim base - checked,
# not assumed: node:22-slim ships no libssl* and no
# /etc/ssl/certs/ca-certificates.crt. Prisma's query engine links against
# libssl3, and every outbound TLS call the backend makes (Anthropic, Resend,
# SMTP) needs the CA bundle.
#
# Retried because this is the step most likely to fail for reasons that have
# nothing to do with EPM. An unreachable Debian mirror fails the build, and in
# a release workflow that means losing a tag to someone else's outage. Three
# tries covers the usual transient case; a mirror that is genuinely
# unreachable still fails, and should.
RUN for i in 1 2 3; do \
      apt-get update \
   && apt-get install -y --no-install-recommends openssl ca-certificates \
   && break; \
      echo "apt attempt $i failed"; [ "$i" = 3 ] && exit 1; sleep 5; \
    done \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

# Unprivileged: the image has no reason to run as root, and `node` already
# exists in the base image.
USER node

EXPOSE 8000

# Migrations are applied by the entrypoint rather than at image build, because
# they need the database and the database does not exist until the stack runs.
# `migrate deploy` only ever applies pending migrations and never prompts or
# resets, which is what makes it safe to run on every start.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/index.js"]
