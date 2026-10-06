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
| `zzz_epm_password_grant.rb` | The sign-in initializer. Source of truth. |
| `zzz_epm_admin_api.rb` | Users settings, the permission catalogue and roles (below). |
| `zzz_epm_admin_settings.rb` | The settings sections: work packages, projects, languages, repositories, emails, incoming email, aggregation, authentication, calendars, avatars. |
| `zzz_epm_admin_catalog.rb` | Create, edit and delete for types, statuses, priorities, custom fields, webhooks and OAuth applications. |
| `zzz_epm_analytics_api.rb` | Read-only export of every work package version (the journals) and of unit costs, for EPM's analytics model (below). |
| `docker-compose.openproject.yml` | Runs OpenProject with every initializer mounted. |
| `setup/automation-account.rb` | Not an initializer: run by hand, like the one below. Creates EPM's automation account — the service principal rules act as — and its minimal "EPM Automation" project role with a complete workflow, and prints the account's API key once (`ROTATE=1` issues a new one). Not an administrator; EPM adds it to a project when a rule first acts there. |
| `setup/governance-types.rb` | Not an initializer: a one-off `rails runner` script, run by hand. Creates the Change Request and Risk types, the Pending approval / Approved / Rejected statuses with their workflow, and the Change value field that approval thresholds read. Creates only what is missing, so it is safe to run again. Copied to `/app/epm-setup/` in the image. |

## Container destination

```
/app/config/initializers/zzz_epm_password_grant.rb
/app/config/initializers/zzz_epm_admin_api.rb
/app/config/initializers/zzz_epm_admin_settings.rb
/app/config/initializers/zzz_epm_admin_catalog.rb
/app/config/initializers/zzz_epm_analytics_api.rb
```

The `zzz_` prefix matters: Rails loads initializers alphabetically, and the
sign-in one must run after `doorkeeper.rb` has finished configuring.

## The admin API (`zzz_epm_admin_api.rb`)

OpenProject's REST API has no endpoints for the users settings, the permission
catalogue or role editing; they exist only as HTML forms in its admin UI. This
initializer adds them as JSON endpoints under `/epm_admin/*` on the instance,
which EPM's `/admin/settings/users`, `/admin/permissions` and `/admin/roles`
routes consume (see `docs/administration-design.md`, "Users and permissions").

| Method | Path | Does |
| --- | --- | --- |
| GET, PATCH | `/epm_admin/settings/users` | Default language, time zone, display format, deletion, consent |
| GET | `/epm_admin/permissions` | Every settable permission, grouped by module as the role form groups them |
| GET, POST | `/epm_admin/roles` | Roles with their permissions; create one |
| PATCH, DELETE | `/epm_admin/roles/:id` | Rename or re-permission; delete (refused for built-in or assigned roles) |

**Admin only.** The caller is identified the way API v3 identifies it (an OAuth
bearer token or `apikey:<key>` Basic auth) and refused with 403 unless that
user is an active administrator. Writes go through OpenProject's own
`Settings::UpdateService` and `Roles::*Service`, so its validation and
notifications apply unchanged.

To apply it to a running container without recreating it:

```bash
docker cp backend/openproject/zzz_epm_admin_api.rb openproject:/app/config/initializers/zzz_epm_admin_api.rb
docker restart openproject
```

Verify it is live (an unauthenticated call is refused by the initializer, not
by a routing error):

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/epm_admin/permissions   # 403
curl -s -u apikey:<key> http://localhost:8080/epm_admin/roles                            # JSON array
```

Like the sign-in patch, everything it touches — `Roles::BaseContract`,
`Settings::UpdateService`, `Doorkeeper::AccessToken`, `Token::API`,
`OpenProject::AccessControl` — is internal OpenProject API with no
compatibility guarantee. After an upgrade, re-run the two checks above; a 404
means the routes or controller no longer load and the three EPM admin pages
built on them will report an upstream error until the file is adapted.

## The analytics export (`zzz_epm_analytics_api.rb`)

OpenProject keeps every version of every work package — the journal behind each
work package's Activity tab — but API v3 shows it only per work package, as
rendered sentences. EPM's analytics model rebuilds the portfolio as at any past
date from those versions (BR-403), so this initializer exports them as rows:

| Method | Path | Does |
| --- | --- | --- |
| GET | `/epm_admin/analytics/journals?cursor=&limit=` | Work package versions changed after the cursor, oldest change first: each version's attributes and custom values, and when it became current |
| GET | `/epm_admin/analytics/journals/summary` | Counts for reconciliation, and the id of every work package that exists |
| GET | `/epm_admin/analytics/cost_entries?cursor=&limit=` | Unit costs (Costs module), which API v3 does not list on 15.5.1 |

**Read-only and admin only**, identified as API v3 identifies a caller. It runs
SELECTs on `journals`, `work_package_journals`, `customizable_journals`,
`cost_entries` and `cost_types`; Postgres builds each page as JSON. Paging is by
`(updated_at, id)`, because a version OpenProject merges (the same person's
changes within the aggregation window, 5 minutes by default) is rewritten in
place with a later `updated_at`; history therefore resolves to that window. The
cursor is opaque and carries microseconds.

It reads OpenProject's schema directly, with no compatibility guarantee. After
an upgrade:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/epm_admin/analytics/journals/summary   # 403
curl -s -u apikey:<key> http://localhost:8080/epm_admin/analytics/journals/summary                      # JSON
```

then run a full refresh (`npm run analytics -- refresh full`) and check that it
reconciles; `npm run analytics -- capture` then `-- compare <id>` confirms that
reconstruction still matches the instance field for field.

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


## Why there are three admin initializers

OpenProject's REST API is a project-management API, not an administration one.
It reads types, statuses and priorities but publishes no write affordance on
any of them; it does not expose custom fields, webhooks or OAuth applications
at all; and whole settings pages exist only as HTML forms behind the admin UI,
which EPM never shows. Each initializer covers one shape of that gap.

| File | Endpoints | Shape |
| --- | --- | --- |
| `zzz_epm_admin_api.rb` | `/epm_admin/settings/users`, `/epm_admin/permissions`, `/epm_admin/roles` | Bespoke, one endpoint per thing |
| `zzz_epm_admin_settings.rb` | `/epm_admin/sections`, `/epm_admin/sections/:id` | Self-describing field descriptors |
| `zzz_epm_admin_catalog.rb` | `/epm_admin/catalog`, `/epm_admin/catalog/:resource[/:id]` | Self-describing descriptors plus rows |

The later two are self-describing on purpose: the instance reports each field's
type, value, choices and whether it is writable, so EPM renders a page from the
descriptor alone. A setting or column added upstream appears in the product
without a change in the browser, and the alternative — a bespoke page per
section on both sides — is the same form typed three times.

## What an Enterprise licence gates

These are absent rather than broken. An endpoint that always answered 403 would
be worse than no endpoint, so EPM reports them as unavailable instead. Checked
against `EnterpriseToken.allows_to?` on an instance with no token:

- Custom actions
- Attribute help texts (reading them works; creating one does not)
- Project attributes and project lists
- LDAP authentication, SAML providers, OpenID providers
- Two-factor authentication

## After an upgrade

Everything in the two newer files is internal OpenProject API with no
compatibility guarantee: `Settings::UpdateService`, the `Setting.*_writable?`
probes, `ActiveModel::Type::Boolean` casting of plugin settings hashes, and the
`Type`, `Status`, `IssuePriority`, `CustomField`, `Webhooks::Webhook` and
`Doorkeeper::Application` models. Verify each endpoint still answers:

```bash
KEY=<api key>
curl -s -u "apikey:$KEY" http://localhost:8080/epm_admin/sections | head -c 200
curl -s -u "apikey:$KEY" http://localhost:8080/epm_admin/catalog  | head -c 200
```
