# Runbook: rotating secrets (NFR06, NFR14)

Rotate on a schedule (yearly at least), when someone with access leaves, and at once when a secret
may have leaked. Secrets live in the secret store and reach the containers by environment or by
`<NAME>_FILE`; change them there, then restart what reads them. `dc` means
`docker compose -f docker-compose.deploy.yml --env-file .env.prod`.

| Secret | Effect of rotating | Steps |
| --- | --- | --- |
| `SESSION_SECRET` | Every session ends; stored OpenProject tokens become unreadable, so everyone signs in again. | New value (`openssl rand -hex 32`); `dc up -d backend`. The old session rows are no longer usable and expire on their own. |
| `OPENPROJECT_API_KEY` (service key) | None for users. | In OpenProject, create a new API key for the service account and revoke the old one; set it; `dc up -d backend`. |
| `OPENPROJECT_AUTOMATION_API_KEY` | Rules and approval outcomes pause until set. | `dc exec -T -e ROTATE=1 openproject bundle exec rails runner /app/epm-setup/automation-account.rb` prints a new key and revokes the old; set it; `dc up -d backend`. |
| `OPENPROJECT_OAUTH_CLIENT_SECRET` | Sign-in fails until both sides agree; existing sessions keep working until their token refreshes. | In OpenProject (Administration → OAuth applications), regenerate EPM's secret; set it; `dc up -d backend` straight away. |
| `OPENPROJECT_WEBHOOK_SECRET` | Deliveries are refused until both sides agree. | Set the new secret in OpenProject's webhook and in EPM together; `dc up -d backend`. |
| `EPM_RULES_WEBHOOK_SECRET` | Receivers of rule calls must accept the new signature. | Give receivers the new secret first, then set it; `dc up -d backend`. |
| `POSTGRES_PASSWORD` (EPM database) | Backend reconnects with the new one. | `dc exec postgres psql -U epm -c "ALTER USER epm PASSWORD '<new>'"`; set it; `dc up -d backend`. |
| `EPM_ANALYTICS_DB_PASSWORD` / `EPM_REPLICATION_PASSWORD` | Reporting tools / the replica reconnect. | Change the role's password on the primary (`npm run analytics -- role` / `replication`, as in DEPLOY.md); update the tools and `.env.prod`; `dc up -d`. |
| `OPENPROJECT_SECRET_KEY_BASE` | OpenProject's own sessions and signed values are invalidated. | New value; `dc up -d openproject`. EPM's tokens are unaffected (they are OAuth tokens in OpenProject's database). |
| `EPM_METRICS_TOKEN` | Scrapes fail until the scraper has it. | Set it in both; `dc up -d backend`. |
| Mail credentials (`SMTP_PASSWORD`, `RESEND_API_KEY`) | Mail queues until set; nothing is lost. | Rotate at the provider; set; `dc up -d backend`. |
| AWS credentials (assistant) | The assistant fails until set. | Prefer a task role (no key to rotate); otherwise rotate the access key in IAM and set it. |
| Docker Hub token (CI) | Releases fail until set. | New token in Docker Hub; GitHub → Settings → Secrets → `DOCKERHUB_TOKEN`; revoke the old. |
| Backup encryption key | New backups use the new key. | Keep the old private key until every backup made with it has expired. |

After any rotation: `/ready` is 200, sign in works, and the Audit journal shows the system acting as
expected. Record the rotation (what, when, who) in the operations log.
