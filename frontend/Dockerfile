# EPM frontend.
#
# The result is a directory of static files; Caddy serves them. Nothing here
# runs at request time.
#
# `VITE_API_BASE_URL` is a build argument, not an environment variable, because
# Vite inlines it into the bundle at build time. A container started with a
# different value would ignore it — changing the backend address means
# rebuilding this image, not restarting it.

# ---------------------------------------------------------------- build
FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_BASE_URL
ARG VITE_APP_ENV=production
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_APP_ENV=$VITE_APP_ENV

# Fails rather than building if the API address is missing — see
# src/config/env.ts. A bundle that silently points at localhost is the one
# failure mode worth stopping the build for.
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM caddy:2-alpine AS runtime

COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443
