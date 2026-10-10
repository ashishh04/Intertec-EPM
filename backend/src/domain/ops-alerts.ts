import { env } from '../config/env.js';
import { render, type Message } from '../lib/i18n.js';
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
  /**
   * Messages, so each person told reads them in their own language (BR-605).
   * The log line, the journal and the webhook carry them in English.
   */
  title: string | Message;
  body: string | Message;
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

/** A title or body in English, for monitoring, the journal's record and the webhook. Plain text is as given. */
const english = (value: string | Message): string => (typeof value === 'string' ? value : render('en', value));

export async function raiseOperationsAlert(alert: OperationsAlert): Promise<void> {
  const title = english(alert.title);
  const body = english(alert.body);
  appLog.error({ alert: alert.kind, dedupeKey: alert.dedupeKey, ...alert.details }, title);

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
        // The title's message, when it has one, so the journal reads in its
        // reader's language; its English is the same as `title`.
        summary: alert.title,
        reason: body,
        metadata: { kind: alert.kind, dedupeKey: alert.dedupeKey, ...alert.details },
      },
    ]),

    env.EPM_OPS_ALERT_WEBHOOK_URL
      ? postJson(env.EPM_OPS_ALERT_WEBHOOK_URL, {
          kind: alert.kind,
          title,
          body,
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
