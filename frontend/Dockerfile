# EPM frontend: the built bundle, served by Caddy.
#
# The image is domain-agnostic on purpose. Vite inlines its environment at build
# time, so anything named here is frozen into the bundle — and an image with a
# hostname baked in can only ever be deployed to that hostname, which defeats
# pulling a published image. src/config/env.ts therefore resolves the API to the
# relative path `/api` in production, which the browser takes as the origin that
# served the page. Caddy, below, proxies `/api` on that origin to the backend.
#
# The domain is supplied at *run* time instead, as EPM_DOMAIN, which is all the
# Caddyfile needs in order to request a certificate. So the same image tag runs
# on staging and production, and moving a deployment is an env change.
#
# VITE_API_BASE_URL is still accepted, for the one arrangement the relative path
# cannot express: a backend on a different origin. Passing it ties the resulting
# image to that address — do not pass it for the standard single-host deploy.

# Base images are pinned by digest as well as tag, so a rebuild upstream never
# changes a release unseen; Dependabot moves the digests (BR-610).

# ---------------------------------------------------------------- build
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_BASE_URL=""
ARG VITE_APP_ENV=production
ARG VITE_CURRENCY=AED
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_APP_ENV=$VITE_APP_ENV
ENV VITE_CURRENCY=$VITE_CURRENCY

RUN npm run build

# ---------------------------------------------------------------- runtime
FROM caddy:2-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f AS runtime

COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443
