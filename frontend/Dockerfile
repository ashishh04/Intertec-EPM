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
FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build

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
FROM caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS runtime

COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443
