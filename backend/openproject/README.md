# OpenProject patch for EPM sign-in

EPM users sign in on EPM's own form. The backend exchanges their username and
password for that user's OpenProject token, so every request carries the real
caller's identity and permissions. OpenProject does not allow that exchange out
of the box, which is what the file here fixes.

## Status: proof of concept

This is **not** a production-standard OpenProject OAuth deployment. It relies on
the OAuth2 Resource Owner Password Credentials grant, which OAuth 2.1 discourages,
and it patches OpenProject internals that carry no compatibility guarantee.

It is appropriate for a first-party wrapper in a single trust domain, being
evaluated. Before any wider deployment, revisit:

- **Transport.** The grant sends a plaintext password to the EPM backend. HTTPS
  is mandatory off localhost.
- **Upstream coupling.** `Doorkeeper::Config` internals and `User.try_to_login`
  are private API. An OpenProject upgrade can break either without notice.
- **Alternatives.** Authorization Code + PKCE needs no patch at all, but sends
  the user to OpenProject's login page, which defeats the white-labelling this
  exists to provide.

## Why the patch is needed

OpenProject 15.5.1 offers three API authentication mechanisms, and none accepts
a username and password directly:

| Mechanism | Status |
| --- | --- |
| API token (`apikey:<token>` Basic) | Works, but is per-token, not per-login |
| OAuth2 authorization code | Works, but redirects the browser to OpenProject |
| Per-user Basic auth (login/password) | Removed in v15 |
| OAuth2 password grant | Flow disabled, and `resource_owner_from_credentials` is Doorkeeper's unconfigured stub |
| HTML session login | Redirects to `/two_factor_authentication/request`, which 404s |

`zzz_epm_password_grant.rb` enables the password flow and points its credential
handler at `User.try_to_login`. EPM never validates a password itself — password
policy, account status, LDAP and brute-force blocking stay with OpenProject.

## Files

| Path | Purpose |
| --- | --- |
| `zzz_epm_password_grant.rb` | The initializer. Source of truth. |
| `docker-compose.openproject.yml` | Runs OpenProject with the initializer mounted. |

## Container destination

```
/app/config/initializers/zzz_epm_password_grant.rb
```

The `zzz_` prefix matters: Rails loads initializers alphabetically, and this one
must run after `doorkeeper.rb` has finished configuring.

## Running it

```bash
docker compose -f backend/openproject/docker-compose.openproject.yml up -d
```

Data lives in host bind mounts (`pgdata`, `assets`), so recreating the container
does not touch the database or attachments. Set `OPENPROJECT_DATA_DIR` to move
them.

## Verifying the patch is live

```bash
docker exec openproject bash -lc 'RAILS_ENV=production bundle exec rails runner "
  puts Doorkeeper.config.grant_flows.inspect
  puts Doorkeeper.config.resource_owner_from_credentials.source_location.inspect"'
```

Expected: `password` present in the grant flows, and the handler's source
location pointing at `zzz_epm_password_grant.rb` rather than the doorkeeper gem.

End to end:

```bash
curl -s -X POST http://localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<user>","password":"<password>"}'
```

## After an OpenProject upgrade

Change the `image` tag, recreate, then re-run both checks above. If the handler
still resolves into the doorkeeper gem, the mutation no longer applies and
sign-in will fail with `unsupported_grant_type` — the backend surfaces that as
"this instance does not accept password sign-in" rather than a generic error.
