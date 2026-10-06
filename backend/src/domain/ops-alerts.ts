import { env } from '../config/env.js';
import { appLog } from '../lib/log.js';
import { postJson } from '../lib/outbound.js';
import { recordAuditQuietly } from './audit.js';
import { notifyPeople } from './notifications.js';

/**
 * Telling operations that something failed for good (BR-208).
 *
 * The case this exists for is email that could not be delivered after every
 * retry. So nothing here relies on email: the alert is an error-level log line
 * marked `alert` for central monitoring, an in-app notification to the
 * operations people, an entry in the journal, and — when one is configured — a
 * signed POST to an operations webhook. A failure becomes visible somewhere
 * other than the thing that failed, rather than being dropped in silence.
 */

export interface OperationsAlert {
  /** Stable kind for monitoring rules, e.g. `email.delivery_exhausted`. */
  kind: string;
  title: string;
  body: string;
  /** Once per thing that failed: a retry of the same failure is not a new alert. */
  dedupeKey: string;
  /** Where in EPM to look. */
  link?: string;
  details?: Record<string, unknown>;
}

/** Who operations is: those named for it, else the administrators. */
export function operationsPeople(): string[] {
  return env.EPM_OPS_ALERT_USER_IDS.length > 0 ? env.EPM_OPS_ALERT_USER_IDS : env.EPM_ADMIN_USER_IDS;
}

export async function raiseOperationsAlert(alert: OperationsAlert): Promise<void> {
  appLog.error({ alert: alert.kind, dedupeKey: alert.dedupeKey, ...alert.details }, alert.title);

  await Promise.all([
    notifyPeople({
      recipients: operationsPeople(),
      category: 'system',
      title: alert.title,
      body: alert.body,
      link: alert.link,
      severity: 'critical',
      dedupeKey: `ops-alert:${alert.dedupeKey}`,
    }).catch((error: unknown) => appLog.warn({ err: error, alert: alert.kind }, 'The operations alert could not be posted in-app')),

    recordAuditQuietly([
      {
        actorId: null,
        entityType: 'operations',
        entityId: alert.kind,
        action: 'operations.alert',
        summary: alert.title,
        reason: alert.body,
        metadata: { kind: alert.kind, dedupeKey: alert.dedupeKey, ...alert.details },
      },
    ]),

    env.EPM_OPS_ALERT_WEBHOOK_URL
      ? postJson(env.EPM_OPS_ALERT_WEBHOOK_URL, {
          kind: alert.kind,
          title: alert.title,
          body: alert.body,
          at: new Date().toISOString(),
          details: alert.details ?? {},
        }).then((result) => {
          if (!result.ok) {
            appLog.warn({ alert: alert.kind, status: result.status, error: result.error }, 'The operations webhook did not accept the alert');
          }
        })
      : Promise.resolve(),
  ]);
}
