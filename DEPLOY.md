# Deploying EPM

Two ways to run the stack. They produce the same four containers.

| | Builds on the host | Use when |
|---|---|---|
| `docker-compose.deploy.yml` | no — pulls published images | normal deployments |
| `docker-compose.prod.yml` | yes — builds from this checkout | you are changing code on that machine |

The deploy file is the one to use. It needs exactly two files on the server —
itself and `.env.prod` — and no checkout, no Node, no toolchain.

## One-time setup

### 1. Docker Hub credentials, in GitHub

Repository → Settings → Secrets and variables → Actions. Note which tab each
one goes on — they are not interchangeable:

| Tab | Name | Value |
|---|---|---|
| **Variables** | `DOCKERHUB_USERNAME` | your Docker Hub account name, which is also the namespace the images publish under |
| **Secrets** | `DOCKERHUB_TOKEN` | an access token with **Read & Write**, from hub.docker.com → Account settings → Personal access tokens |

The username is a variable, not a secret: an account name is not confidential,
and as a secret it is masked out of the logs, leaving every build line reading
`***/epm-web`. The token is a token and not your password, so it can be revoked
without changing how you sign in anywhere else. The workflow checks both are set
before it does anything, and says which tab is missing one.

### 2. Decide whether the images are public

The release workflow creates three repositories under your namespace the first
time it pushes:

```
<namespace>/epm-backend
<namespace>/epm-web
<namespace>/epm-openproject
```

**Docker Hub's free plan includes one private repository.** Three private ones
need a paid plan. Left public, anyone can `docker pull` them — the backend image
contains EPM's compiled server and its Prisma schema, and the web image contains
the built frontend. Neither holds a secret (every credential arrives as an
environment variable at run time), but both are the product.

Set the visibility you want on each repository in Docker Hub after the first
push. If three private repositories are what you want and you would rather not
pay, GHCR gives unlimited private packages free and the workflow is a short edit
away — the registry appears in three places in `.github/workflows/release.yml`.

### 3. The host

Docker and the compose plugin, port 80 and 443 open, and `EPM_DOMAIN` already
resolving to the machine. Then:

```bash
mkdir -p /srv/epm && cd /srv/epm
curl -O https://raw.githubusercontent.com/ashishh04/Intertec-EPM/main/docker-compose.deploy.yml
# plus .env.prod, copied from .env.prod.example in this repository and filled in
docker login            # only if the images are private
```

The domain must resolve **before** the first `up`. Caddy requests a certificate
on startup and the stack is unusable without one: the backend marks the session
cookie `secure` in production, a secure cookie is never sent over plain HTTP, so
on `http://` sign-in appears to succeed, the cookie is dropped, and the person
lands back on the login form with nothing in any log to explain it.

## Releasing

```bash
git tag v1.0.0
git push origin v1.0.0
```

Actions builds all three images and pushes `1.0.0` and `latest`. There is also a
**Run workflow** button on the *Release images* workflow that takes a tag, for
publishing from a branch without tagging it.

## Deploying

On the host, set `EPM_IMAGE_TAG` in `.env.prod` to the release, then:

```bash
docker compose -f docker-compose.deploy.yml --env-file .env.prod pull
docker compose -f docker-compose.deploy.yml --env-file .env.prod up -d
docker compose -f docker-compose.deploy.yml --env-file .env.prod ps
```

The backend applies pending Prisma migrations as it starts (`migrate deploy`,
which only ever applies and never resets or prompts), so there is no separate
migration step. It reports unhealthy until both Postgres and OpenProject answer;
that is the readiness check doing its job, and it can take a minute on a cold
start while OpenProject boots.

Pin a version rather than tracking `latest`. With a version, `docker ps` tells
you what is deployed and a rollback is one edited line:

```bash
# roll back
sed -i 's/^EPM_IMAGE_TAG=.*/EPM_IMAGE_TAG=1.0.0/' .env.prod
docker compose -f docker-compose.deploy.yml --env-file .env.prod up -d
```

A rollback moves code, not data. A release whose migrations changed the schema
cannot be undone this way — restore the database alongside it.

## After the very first `up`

OpenProject starts empty, and three of its values have to come out of a running
instance and go into `.env.prod`:

1. `OPENPROJECT_API_KEY` — sign in as an administrator → My account → Access
   tokens → API.
2. `OPENPROJECT_OAUTH_CLIENT_ID` / `..._SECRET` — Administration →
   Authentication → OAuth applications. Sign-in needs these: EPM exchanges a
   person's credentials for a token on their behalf.
3. Optionally `OPENPROJECT_WEBHOOK_SECRET` — Administration → API and webhooks.
   Without it EPM still works, it just learns about upstream changes on its own
   schedule.

Then `up -d` again to pick them up. Reaching OpenProject's own UI while only 443
is open means tunnelling to it, since it is deliberately not published:

```bash
ssh -L 8080:localhost:8080 user@host
docker run --rm -d --network epm_epm -p 8080:80 alpine/socat tcp-listen:80,fork tcp:openproject:80
```

## What is in each image

| Image | Contents |
|---|---|
| `epm-backend` | `dist`, production modules, the generated Prisma client, the Prisma CLI for migrations |
| `epm-web` | the built bundle plus Caddy and the Caddyfile; no domain baked in |
| `epm-openproject` | `openproject/openproject:15` plus the four EPM initializers |
| `postgres:17-alpine` | pulled from the official library, nothing of ours in it |

`epm-openproject` exists because EPM cannot use a stock OpenProject: sign-in
depends on `zzz_epm_password_grant.rb` being loaded inside that container, and
the other three initializers add the administrative endpoints EPM reads. They
used to be bind-mounted from a checkout, which made the host depend on this
repository being present at the right commit — and a stack that comes up with
the mount missing starts cleanly and then refuses every sign-in. Baked into the
image, they travel with the tag.

`epm-web` carries no domain because `src/config/env.ts` resolves the API to the
relative path `/api` in production, which the browser takes as the origin that
served the page; Caddy proxies `/api` there to the backend. So one image runs on
staging and production both, and moving domains is an environment change rather
than a rebuild. `VITE_API_BASE_URL` remains a build argument for the one case a
relative path cannot express — a backend on a different origin — and setting it
ties that image to that address.

## Data

| What | Where |
|---|---|
| OpenProject database and attachments | bind mount at `OPENPROJECT_DATA_DIR`, default `/srv/openproject` |
| EPM database | named volume `epm-pgdata` |
| TLS certificates | named volume `caddy-data` |

OpenProject's data is a bind mount on purpose: a path can be pointed at a
mounted disk, and a mounted disk can be snapshotted independently of the
instance. `caddy-data` must survive a recreate — without it Caddy re-issues on
every deploy and will meet Let's Encrypt's rate limit.

```bash
docker compose -f docker-compose.deploy.yml --env-file .env.prod exec postgres \
  pg_dump -U epm epm | gzip > epm-$(date +%F).sql.gz
```
