# EPM security posture

Current as of the P0 stabilization work. This describes what holds today, and
what must be true before the system is reachable from anything but localhost.

## Architecture

```
Browser ──HTTPS──> EPM frontend
   │
   └────HTTPS────> EPM backend (BFF) ──HTTPS──> OpenProject
                        │
                        └──> EPM PostgreSQL (EPM-owned metadata only)
```

The browser talks only to the frontend origin and the backend. It never reaches
OpenProject, holds no OpenProject token, and is not told where OpenProject is.
Verified by instrumenting a real browser session across every route: the only
origins contacted are the app, the backend, and the font CDN.

OpenProject must not be exposed to users directly. It is reachable from the
backend only.

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

Permissions derive from `GET /api/v3/capabilities` for the signed-in user, read
with that user's own token. Global and project scopes are kept separate.

The frontend hides what a user may not do. **That is presentation only.** The
backend authorises every mutation independently and never trusts a client-supplied
permission flag. Verified by calling every mutating endpoint directly, with no
frontend involved: restricted users receive 403, anonymous callers 401.

Permissions with no authoritative upstream source are denied rather than
guessed. See `UNMAPPED` in `src/auth/permissions.ts`.

## Required before leaving localhost

These are **not** satisfied today. The system is not production-ready until they
are.

1. **HTTPS end to end.** The password grant sends a plaintext password to the
   backend. On plain HTTP it is recoverable by anyone on the path. Terminate TLS
   in front of the frontend and the backend, and use HTTPS or a private network
   segment for backend → OpenProject.

2. **`NODE_ENV=production`.** The session cookie only gets the `Secure`
   attribute when this is set. Without it the cookie can be sent over HTTP.

3. **A real `SESSION_SECRET`.** It signs session cookies and derives the token
   encryption key. Generate with `openssl rand -hex 32`. Rotating it invalidates
   every session and makes stored tokens undecryptable, which fails closed.

4. **A real `OPENPROJECT_SECRET_KEY_BASE`.** The compose file defaults it to
   `secret` for local use, matching the original container. That is not
   acceptable off a laptop.

5. **CSRF review.** The session cookie is `sameSite=lax`, and mutations are
   POST/PATCH/DELETE with `Content-Type: application/json`, which browsers will
   not send cross-origin without a preflight that CORS refuses. That is the
   current defence. If the frontend and backend ever land on different sites, or
   form-encoded bodies are accepted, add explicit CSRF tokens.

6. **Rate limiting on sign-in.** `@fastify/rate-limit` is registered globally.
   Confirm the limit is appropriate for `/auth/login` specifically, since
   OpenProject's own brute-force blocking counts attempts per account, not per
   caller.

## Logging

`req.headers.authorization`, `req.headers.cookie` and `res.headers["set-cookie"]`
are redacted. Request bodies are not logged, so the sign-in password never
reaches a log line — verified by signing in and searching the output for the
password, bearer tokens and session ids. All three: zero matches.

## Secrets in the repository

`backend/.env` is gitignored. `backend/.env.example` carries variable names and
non-secret defaults only; every secret-bearing key is empty. `frontend/.env` is
tracked deliberately — `VITE_*` values are compiled into the client bundle and
so cannot be secret by construction.
