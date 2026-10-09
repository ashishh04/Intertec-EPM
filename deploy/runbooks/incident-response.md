# Runbook: incident response (NFR14)

For anything that stops people working or may have exposed data. Commands assume the deployment
host, in the directory holding `docker-compose.deploy.yml` and `.env.prod`; `dc` below means
`docker compose -f docker-compose.deploy.yml --env-file .env.prod`.

## 1. Detect and confirm

Most incidents arrive as an alert (`deploy/monitoring/epm-alerts.yml`) or a report from a user.

| Signal | First check |
| --- | --- |
| EpmBackendDown / users see "Unable to reach the EPM backend" | `dc ps`; `dc logs --tail=200 backend` |
| EpmDependencyDown (openproject) | `dc logs --tail=200 openproject`; OpenProject takes a minute or two after a restart |
| EpmDependencyDown (database) | `dc logs --tail=200 postgres`; disk space (`df -h`) |
| EpmSlowResponses | `epm_openproject_request_duration_seconds` on the dashboard — OpenProject is the usual cause; host CPU and memory |
| EpmServerErrors | backend log lines at error level, which carry `route` and `userId` |
| EpmEmailBacklog / EpmEmailGivingUp | Administration → Emails; the relay's reachability |
| Suspected data exposure or misuse | go to section 3 at once |

## 2. Restore service

1. If one container is unhealthy: `dc restart <service>`; check `/ready` (`dc exec -T backend node -e "fetch('http://localhost:8000/ready').then(r=>r.text()).then(console.log)"`).
2. If a release caused it: roll back to the previous tag (`EPM_IMAGE_TAG` in `.env.prod`, then `dc pull && dc up -d`). A release that ran a database migration needs the backup taken before it (`deploy/backup/README.md`).
3. If data is damaged: restore (`deploy/backup/README.md`, runbook).
4. Say what happened and when it will be back, to the people affected, as soon as the cause is known.

## 3. Contain a security incident

Act first, investigate second. Each step is journalled (Administration → Audit journal).

| Concern | Containment |
| --- | --- |
| An account is compromised | Administration → Users: **Revoke access** (ends every session, removes project memberships and administrator rights), then lock the account; reset its password in OpenProject. |
| Many sessions may be compromised | Rotate `SESSION_SECRET` (runbook: secret rotation) — everyone is signed out. |
| A service key may have leaked | Rotate it (runbook: secret rotation): the OpenProject API key, the automation key, the OAuth client secret, the webhook secrets. |
| A permission was granted wrongly | Administration → Users and permissions → EPM permissions: remove it; the change is journalled and effective within a minute. |
| The assistant is misbehaving or leaking | Unset `BEDROCK_MODEL_ID` and `dc up -d backend`: the assistant reports itself unavailable to everyone. |
| A dependency vulnerability is being exploited | Vulnerability and patch process: critical, out of band; consider taking the affected feature offline meanwhile. |

## 4. Investigate

- **Who did what:** Audit journal (filter by kind, person, dates; export a page). OpenProject's own
  journals hold changes made inside OpenProject.
- **Requests:** backend logs, by `route`, `userId` and `reqId`; sign-ins and refusals are at warn
  level.
- **Mail:** Administration → Emails shows what was queued, sent or failed, and to whom.
- Preserve evidence before changing anything further: copy the logs and take a backup.

## 5. Recover and review

1. Confirm the cause is removed, not just the symptom.
2. Write the incident record within five working days: timeline, impact, cause, what was changed,
   and the follow-ups with owners. Blameless: it describes the system, not people.
3. If personal data was exposed, follow the client's data protection procedure and its deadlines.
