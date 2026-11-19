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

# Both stages are pinned by digest as well as tag, so a rebuild upstream never
# changes a release unseen. Dependabot moves the digest when node:22-slim is
# rebuilt, which is how Debian and Node security fixes arrive (BR-610).

# ---------------------------------------------------------------- build
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build

# openssl in the build stage too, and not for TLS: `prisma generate` chooses its
# query engine by detecting the OpenSSL version present, and with no libssl
# installed it settles on debian-openssl-1.1.x. The runtime stage below does
# install libssl3, so the client generated here would be the wrong binary and
# the first query would fail with the engine missing — long after the build
# reported success.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

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

# ---------------------------------------------------------------- plans
# Microsoft Project's own files (.mpp, .mpt, .mpx) are read on Tasks → Import
# through MPXJ (src/domain/ms-project.ts), a Java library: nothing written for
# Node reads them. This stage cuts a Java runtime down to the modules MPXJ and
# its libraries use — about 60 MB rather than a whole JDK — and unpacks MPXJ's
# jars (about 30 MB) from its release, checked against the release's checksum.
# Microsoft Project XML needs neither: the backend reads that itself.
#
# The module list came from `jdeps` over MPXJ and its libraries, and was tried
# by converting a real .mpp with the runtime this stage makes, on the runtime
# stage's base image and as its `node` user. To move MPXJ on, change
# both arguments: the new zip's SHA-256 is printed by `sha256sum` on it.
#
# Writing .mpp on Tasks → Export is Aspose.Tasks for Java's (MPXJ only reads
# it): its jar from Aspose's Maven repository, checked against its SHA-256,
# and EPM's helper (tools/mpp-writer), compiled here against it. Aspose.Tasks
# writes .mpp only with its licence, set at run time (EPM_ASPOSE_TASKS_LICENSE);
# without one the export offers Microsoft Project XML instead. It needs no
# module the runtime above lacks (jdeps: java.base, java.desktop, java.sql).
FROM eclipse-temurin:21.0.13_9-jdk-noble@sha256:a2e61ec9e2e4d5c7aa885412400319f9299abe4d8189f42ec3bec48708c576a6 AS plans

ARG MPXJ_VERSION=16.11.0
ARG MPXJ_SHA256=765f0f5e459f27b7f12511bea682f13937d92ddd37d5422a693d746c6a490273
ARG ASPOSE_TASKS_VERSION=26.10
ARG ASPOSE_TASKS_SHA256=be40d5a153c60cb892cc21de81915e7e6c4ded39a56fe15991d8279afaacb7e9

RUN jlink \
      --add-modules java.base,java.desktop,java.logging,java.naming,java.net.http,java.prefs,java.scripting,java.sql,java.xml,jdk.unsupported,jdk.zipfs,jdk.charsets \
      --strip-debug --no-man-pages --no-header-files --compress=zip-6 \
      --output /opt/jre

RUN for i in 1 2 3; do \
      apt-get update \
   && apt-get install -y --no-install-recommends curl unzip ca-certificates \
   && break; \
      echo "apt attempt $i failed"; [ "$i" = 3 ] && exit 1; sleep 5; \
    done \
 && curl -fsSL --retry 3 -o /tmp/mpxj.zip "https://github.com/joniles/mpxj/releases/download/v${MPXJ_VERSION}/mpxj-${MPXJ_VERSION}.zip" \
 && echo "${MPXJ_SHA256}  /tmp/mpxj.zip" | sha256sum -c - \
 && mkdir -p /opt/mpxj/lib \
 && unzip -q -j /tmp/mpxj.zip 'mpxj/mpxj.jar' -d /opt/mpxj \
 && unzip -q -j /tmp/mpxj.zip 'mpxj/lib/*' -d /opt/mpxj/lib \
 && rm -f /opt/mpxj/lib/junit-* /opt/mpxj/lib/opentest4j-* /opt/mpxj/lib/apiguardian-* \
 && test -f /opt/mpxj/mpxj.jar \
 && rm -rf /tmp/mpxj.zip /var/lib/apt/lists/*

COPY tools/mpp-writer/EpmMppWriter.java /tmp/mpp-writer/EpmMppWriter.java
RUN mkdir -p /opt/aspose /tmp/mpp-writer/classes \
 && curl -fsSL --retry 3 -o /opt/aspose/aspose-tasks.jar "https://releases.aspose.com/java/repo/com/aspose/aspose-tasks/${ASPOSE_TASKS_VERSION}/aspose-tasks-${ASPOSE_TASKS_VERSION}.jar" \
 && echo "${ASPOSE_TASKS_SHA256}  /opt/aspose/aspose-tasks.jar" | sha256sum -c - \
 && javac --release 21 -cp /opt/aspose/aspose-tasks.jar -d /tmp/mpp-writer/classes /tmp/mpp-writer/EpmMppWriter.java \
 && jar cf /opt/aspose/epm-mpp-writer.jar -C /tmp/mpp-writer/classes . \
 && rm -rf /tmp/mpp-writer

# ---------------------------------------------------------------- runtime
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime

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

# No package manager in the image that runs. It starts `node` and the Prisma
# CLI straight from node_modules (see CMD); npm, npx, corepack and yarn would
# only be more code for an intruder to use and more findings for a scanner.
# Maintenance commands run as `node dist/scripts/...` (DEPLOY.md).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

WORKDIR /app
ENV NODE_ENV=production

# Owned by the user that will run them. Without --chown these arrive as root,
# and `prisma migrate deploy` in the entrypoint then cannot write to
# node_modules/@prisma/engines, where the CLI unpacks the engine binaries on
# first use — so the container crash-loops on start with a permissions error
# that reads like a broken install rather than a file ownership problem.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package.json ./package.json

# Reading and writing Microsoft Project files (the plans stage above). Root-owned and only
# read and run: the node user needs nothing more.
COPY --from=plans /opt/jre /opt/jre
COPY --from=plans /opt/mpxj /opt/mpxj
COPY --from=plans /opt/aspose /opt/aspose
ENV EPM_JAVA=/opt/jre/bin/java \
    EPM_MPXJ_HOME=/opt/mpxj \
    EPM_ASPOSE_TASKS_HOME=/opt/aspose

# Unprivileged: the image has no reason to run as root, and `node` already
# exists in the base image.
USER node

EXPOSE 8000

# Migrations are applied by the entrypoint rather than at image build, because
# they need the database and the database does not exist until the stack runs.
# `migrate deploy` only ever applies pending migrations and never prompts or
# resets, which is what makes it safe to run on every start.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/index.js"]
