# EPM backend.
#
# Two stages so the runtime image carries no TypeScript, no source and no dev
# dependencies — only `dist`, the production modules and the Prisma client.
#
# The Prisma client is generated in the build stage and copied forward: it is
# platform-specific native code, so generating it anywhere other than the image
# it runs in produces a binary the runtime cannot load.

# ---------------------------------------------------------------- build
FROM node:22-slim AS build

WORKDIR /app

# Prisma's postinstall needs the schema present, so it is copied with the
# manifests rather than with the rest of the source.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# Drop everything the runtime will not use. Done here rather than by copying
# selectively below, so the layer that ships is the one that was tested.
RUN npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:22-slim AS runtime

# OpenSSL is a Prisma runtime dependency and is not in the slim base.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
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
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
