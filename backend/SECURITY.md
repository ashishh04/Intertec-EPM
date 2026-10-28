# EPM security posture

This describes what holds today, and what must be true before the system is
reachable from anything but localhost. Last checked against the code in October
2026.

## Architecture

```
Browser ──HTTPS──> EPM frontend
   │
   └────HTTPS────> EPM backend (BFF) ──HTTPS or private network──> OpenProject
                        │
                        └──> EPM PostgreSQL (EPM-owned metadata only)
```

The browser talks only to the frontend origin and the backend; in the compose
stacks they are one origin, since Caddy serves the app and proxies `/api` to
the backend. It never reaches OpenProject, holds no OpenProject token, and is
not told where OpenProject is. Caddy gives the app's pages a
Content-Security-Policy that lets them load from and connect to their own
origin and no other (`frontend/Caddyfile`); fonts are bundled.

OpenProject must not be exposed to users directly. It is reachable from the
backend only: `docker-compose.deploy.yml` and `docker-compose.prod.yml` do not
publish it.

## Authentication

Users sign in on EPM's own form. The backend exchanges those credentials for
that user's OpenProject token using the OAuth2 password grant, and returns only
an opaque session id in an HTTP-only cookie.

**This is a proof of concept, not a production-standard OAuth deployment.** It
depends on a patch to OpenProject — see `backend/openproject/README.md` — and on
a grant type that OAuth 2.1 discourages. It is appropriate for a first-party
wrapper in one trust domain, under evaluation.

| Property | State |
| --- | --- |
| Password reaches the browser's JS? | No — posted once, never stored client-side |
| Password stored by EPM? | No — used once in-process, never persisted or logged |
| Password validated by EPM? | No — `User.try_to_login` on OpenProject, so its policy, account status, LDAP and brute-force blocking still apply |
| Tokens at rest | AES-256-GCM, key derived from `SESSION_SECRET` |
| Tokens in the browser | Never — only an opaque session id |
| Refresh | Automatic, 60s before expiry, with rotation handling |
| Account enumeration | Prevented — wrong password and unknown user return an identical response |

## Session cookie

| Attribute | Value | Note |
| --- | --- | --- |
| `httpOnly` | true | Not readable from JS |
| `signed` | true | Tampering is detected; a forged cookie is refused |
| `sameSite` | `lax` | Adequate for the current same-site deployment — see CSRF below |
| `secure` | `isProduction` | **Only set when `NODE_ENV=production`** |
| `maxAge` | 30 days | Server-side expiry is authoritative |

## Authorization

OpenProject's permissions derive from `GET /api/v3/capabilities` for the
signed-in user, read with that user's own token. Global and project scopes are
kept separate.

The frontend hides what a user may not do. **That is presentation only.** The
backend authorises every mutation independently and never trusts a client-supplied
permission flag. Verified by calling every mutating endpoint directly, with no
frontend involved: restricted users receive 403, anonymous callers 401.

Permissions with no authoritative upstream source are denied rather than
guessed. See `UNMAPPED` in `src/auth/permissions.ts`.

EPM's own permissions, for what OpenProject has no concept of (departments,
teams, health, rules, rates, the audit journal and the rest), come from EPM
instead (`src/auth/grants.ts`), in three ways. An administrator grants them one
at a time, under Administration → Users and permissions → EPM permissions
(`src/routes/permission-grants.ts`). A person's EPM role (Manager, HR, Employee
or External), which an administrator sets under Access roles on the same menu
(`src/routes/app-roles.ts`), brings a fixed set: `ROLE_PERMISSIONS` in
`src/auth/roles.ts`. And administrators, meaning whoever OpenProject lets
manage users and the people in `EPM_ADMIN_USER_IDS`, hold every one. A role
only adds to a person's grants, and nothing EPM grants widens an answer
OpenProject has given. External holds a person to the portal: every other route
refuses them before it runs (`src/auth/hook.ts`). Both pages are for
administrators only, and each grant and each change of role is journalled with
who made it.

Three credentials reach OpenProject, and the client picks one for each call
(`src/openproject/client.ts`):

| Who is acting | Credential | OpenProject account |
| --- | --- | --- |
| A signed-in person | their own OAuth access token | their own, with their own permissions |
| EPM's own work: background jobs, instance-wide reads, a project's library documents (below), and the pages that run without a session, such as accepting an invitation and resetting a password | the system key, `OPENPROJECT_API_KEY` | `epm-service`, not an administrator |
| A rule's actions, run inside `runAsAutomation` (`src/auth/context.ts`) | `OPENPROJECT_AUTOMATION_API_KEY` | `epm-automation`, not an administrator |

`epm-service` is made by `backend/openproject/setup/service-account.rb`. It
holds a global role with `view_all_principals` and `view_user_email` only, and
in every project a role with each `view_…` permission plus `view_project`,
`view_members` and `manage_members`; `zzz_epm_service.rb` adds it to each new
project. Where an EPM add-on action is for administrators, the service account
may call it only if `EpmService::ALLOWED` in `zzz_epm_service.rb` lists it: the
analytics extract, the schedule and calculated-field bridges, cost types and
entries, the role list, who is an administrator, the library's documents, the
two password actions, and the custom fields in the administration catalogue. A
server still on an administrator's key works the same way, with an
administrator's reach; `DEPLOY.md` says how to move it.

`epm-automation` is made by `backend/openproject/setup/automation-account.rb`.
Its project role reads, creates and edits work packages, changes their status,
relates and nests them, comments on them and assigns versions, and nothing that
administers a project; EPM adds it to a project the first time a rule acts
there. A call made as it without its key is refused, never sent on the system
key instead.

Library documents are read more widely than OpenProject alone would allow. A
document is an attachment with no container, which OpenProject shows to its
uploader alone. EPM files it under a project in its own index, and for anyone
who may view that project it reads the file as `epm-service`, through the admin
add-on's `document` and `document_content` (`src/routes/documents.ts`). Those
serve container-less files only, never an attachment on a work package or a
wiki page, and `document_content` refuses a file that is quarantined or not yet
scanned. Filing a document under a project needs the same permission, and one
filed under no project is read with the caller's own token. Deleting a document
stays with whoever OpenProject offers that to: its uploader or an
administrator.

## Forgotten passwords

Someone who cannot sign in asks for a link by username or email, and chooses a
new password with it (`src/routes/password-reset.ts`,
`src/domain/password-reset.ts`).

| Property | State |
| --- | --- |
| The token | 32 random bytes, sent only in the emailed link. `password_reset_tokens` keeps a SHA-256 of it, never the token. The email's outbox row holds the link only while the email may still be sent, since it is rendered then, and drops it once the email has gone or never will (`src/email/outbox.ts`; invitations alike) |
| Use | Once, within 60 minutes, claimed atomically before the password is written. A newer link replaces every older unused one |
| Account enumeration | Prevented — the answer is the same, and immediate, whether or not the username or email matches an account; the lookup and the email happen after it. With no mail delivery the request is refused for everyone alike |
| Rate limits | 5 requests per 15 minutes from one address (item 6 below says how a caller is counted), and at most 3 links per account per hour |
| Who may be reset | Decided inside OpenProject by the admin add-on, whoever calls it: never an administrator who has signed in (they are emailed why instead), an inactive account, or one of EPM's own accounts |
| Setting the password | By the add-on's `set_password`, called as `epm-service`, through OpenProject's `User` model, so the instance's password rules apply |
| Afterwards | The add-on revokes every OAuth token the person holds and EPM deletes their sessions, so they are signed out everywhere. Sending a link and using it are both journalled |

## Required before leaving localhost

The compose files that run EPM on a server, `docker-compose.deploy.yml` and
`docker-compose.prod.yml`, now provide the first four, and the sixth is in the
code. The fifth is still open.

1. **HTTPS end to end.** The password grant sends a plaintext password to the
   backend. On plain HTTP it is recoverable by anyone on the path. In the
   compose stacks Caddy terminates TLS for the app and the API on
   `EPM_DOMAIN`, with a certificate it obtains itself, and sends HSTS. The
   backend and OpenProject are not published, and the backend reaches
   OpenProject over the stack's internal network (`http://openproject`), which
   is the private segment this asks for. Run any other way, terminate TLS in
   front of the frontend and the backend, and use HTTPS or a private network
   segment for backend → OpenProject.

2. **`NODE_ENV=production`.** The session cookie only gets the `Secure`
   attribute when this is set. Both compose files set it for the backend, and
   so does the backend image.

3. **A real `SESSION_SECRET`.** It signs session cookies and derives the token
   encryption key. Both compose files refuse to start without one, and the
   backend refuses one shorter than 32 characters. Generate with
   `openssl rand -hex 32`. Rotating it invalidates every session and makes
   stored tokens undecryptable, which fails closed.

4. **A real `OPENPROJECT_SECRET_KEY_BASE`.** Both compose files refuse to start
   without it, and pass it to OpenProject as `SECRET_KEY_BASE` as well, the
   name OpenProject reads; it will not boot on a default. Only the local
   development file, `backend/openproject/docker-compose.openproject.yml`, still
   defaults it to `secret` and waives that check, so that the local instance's
   API keys keep working. That is not acceptable off a laptop.

5. **CSRF review.** The session cookie is `sameSite=lax`, and most mutations
   are POST/PUT/PATCH/DELETE with `Content-Type: application/json`, which
   browsers will not send cross-origin without a preflight that CORS refuses.
   File uploads are the exception: attachments, documents, receipts, portal
   files and task imports take `multipart/form-data`, which a cross-site form
   can send without a preflight. For those the `lax` cookie is the defence, as
   a browser does not attach it to a cross-site POST. Form bodies are the case
   this item has always said needs explicit CSRF tokens, and there are none
   yet. They also become necessary if the frontend and backend ever land on
   different sites.

6. **Rate limiting.** `@fastify/rate-limit` is registered globally
   (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`, 600 a minute by default), and
   `/auth/login` has its own limit of 10 a minute, since OpenProject's own
   brute-force blocking counts attempts per account, not per caller. A
   signed-in request is counted against its session, by a session cookie this
   server signed only, so making up a cookie does not start a new count.
   Signing in, and the public invitation and password-reset routes, are
   counted against the IP address whatever cookie comes with them, so an
   account signed in a few times is not a fresh allowance of guesses either
   (`src/app.ts`).

## Logging

A request is logged as its method, URL, host name and the caller's address and
port, with no headers and no body (the request serializer in `src/app.ts`). In
the URL, the token of an invitation or password-reset link (`/invites/…`,
`/password-reset/…`) is replaced with `[redacted]`: until it is used it opens
an account, and whoever can read the logs must not be able to use it. A
password-reset request is logged by its outcome, not by the username or email
it named. `req.headers.authorization`, `req.headers.cookie`,
`res.headers["set-cookie"]` and `password` in a body are redacted as well,
should a log line ever carry them. Request bodies are not logged, so the
sign-in password never reaches a log line — verified by signing in and
searching the output for the password, bearer tokens and session ids. All
three: zero matches.

## Secrets in the repository

`backend/.env` is gitignored. `backend/.env.example` carries variable names and
non-secret defaults only; every secret-bearing key is empty. `frontend/.env` is
tracked deliberately — `VITE_*` values are compiled into the client bundle and
so cannot be secret by construction.
