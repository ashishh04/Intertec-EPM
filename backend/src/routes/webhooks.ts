import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { env } from '../config/env.js';
import { invalidateProjectCost } from '../domain/costs.js';
import { requestHealthRecalc } from '../domain/health.js';
import { requestScheduleRecalc } from '../domain/schedule.js';
import { requestCalculatedRecalc } from '../domain/calculated-fields.js';
import { eventKeyOf, receiveEvent, registerProcessor } from '../domain/integration-inbox.js';
import { enqueueEmail } from '../email/outbox.js';
import { getPreferences } from '../email/preferences.js';
import { resolveRecipient } from '../email/recipients.js';
import { EpmError } from '../lib/errors.js';
import { t, toLanguage, type Language } from '../lib/i18n.js';
import { appLog } from '../lib/log.js';
import { linkId, linkTitle } from '../openproject/client.js';
import type { HalLinks } from '../openproject/types.js';
import { noteRuleEvent, noteWebhookReceived } from '../domain/rule-events.js';

/**
 * Inbound webhooks from OpenProject.
 *
 * Configured upstream under Administration → API and webhooks, pointed at this
 * route with the shared secret from `OPENPROJECT_WEBHOOK_SECRET`. Every
 * delivery is signed with an HMAC of the raw body, so the body has to be kept
 * as the bytes that arrived — which is why this plugin installs its own JSON
 * parser: Fastify's default hands over the parsed object and discards the
 * text it came from. The parser is scoped to this plugin; nothing else in the
 * API sees a change.
 *
 * Once the signature checks out, a delivery never fails loudly. OpenProject
 * retries a non-2xx and disables a webhook that keeps failing, so it is
 * answered 204 whatever happens next — and kept (BR-506): every delivery goes
 * into the integration inbox once, keyed on a hash of its bytes, so a
 * redelivery is only counted; it is processed there, and a failure is retried
 * with back-off and dead-lettered when the retries run out, for an operator to
 * replay. Processing is idempotent — emails and rule events are keyed, the
 * recalculations ask for a pass — so a replay changes nothing twice.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** The body as received, for signature verification. Webhooks only. */
    rawBody?: string;
  }
}

const HANDLED_ACTIONS = new Set(['work_package:created', 'work_package:updated']);

/** The parts of the payload's work package this reads. HAL, like the API. */
interface WebhookWorkPackage {
  id: number;
  subject?: string;
  lockVersion?: number;
  updatedAt?: string;
  _links?: HalLinks;
  _embedded?: { project?: { identifier?: string; name?: string } };
}

interface WebhookBody {
  action?: string;
  work_package?: WebhookWorkPackage;
  time_entry?: { id?: number; _links?: HalLinks };
  project?: { id?: number };
}

/**
 * Which project's health an event may have moved, if any.
 *
 * Work package and time entry events carry their project as a link; a project
 * event is about the project itself. Anything else changes nothing health
 * reads. Edits made through EPM already ask for a recalculation themselves —
 * this is what catches the ones made directly in the instance.
 */
function healthRelevantProject(action: string, body: WebhookBody): string | undefined {
  if (action.startsWith('work_package:')) return linkId(body.work_package?._links, 'project');
  if (action.startsWith('time_entry:')) return linkId(body.time_entry?._links, 'project');
  if (action.startsWith('project:') && typeof body.project?.id === 'number') return String(body.project.id);
  return undefined;
}

/**
 * `sha1=<hex>` over the raw body. Compared in constant time, and only after
 * the lengths match — `timingSafeEqual` throws otherwise, which would turn a
 * malformed header into a 500.
 */
function verifySignature(request: FastifyRequest): void {
  const secret = env.OPENPROJECT_WEBHOOK_SECRET;
  if (!secret) {
    throw EpmError.unavailable('Webhooks are not configured on this deployment.');
  }

  const header = request.headers['x-op-signature'];
  const given = (Array.isArray(header) ? header[0] : header) ?? '';
  const presented = given.startsWith('sha1=') ? given.slice('sha1='.length) : given;

  const expected = createHmac('sha1', secret)
    .update(request.rawBody ?? '')
    .digest('hex');

  const a = Buffer.from(presented.toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw EpmError.unauthorized('The webhook signature did not match.');
  }
}

/** The same key the task mapping shows: `IDENT-123`, or `WP-123` without one. */
function taskKeyOf(workPackage: WebhookWorkPackage): string {
  const identifier = workPackage._embedded?.project?.identifier;
  return identifier ? `${identifier.slice(0, 6).toUpperCase()}-${workPackage.id}` : `WP-${workPackage.id}`;
}

async function handleWorkPackage(action: string, body: WebhookBody, log: { warn(obj: object, msg: string): void }): Promise<void> {
  const workPackage = body.work_package;
  if (!workPackage || typeof workPackage.id !== 'number') {
    log.warn({ action }, 'Webhook payload had no work package');
    return;
  }

  const id = String(workPackage.id);
  const assigneeId = linkId(workPackage._links, 'assignee');
  if (!assigneeId) return;

  // Creating a work package and assigning it to yourself is not news to you.
  const authorId = linkId(workPackage._links, 'author');
  const selfAssignedOnCreate = action === 'work_package:created' && authorId === assigneeId;

  const recipient = await resolveRecipient(assigneeId);
  if (!recipient) return;

  // What stands in for a name the delivery did not carry is written in the
  // language the email will be: the assignee's, from their preferences, as
  // the outbox reads it. Asked only when something is missing.
  const project = linkTitle(workPackage._links, 'project') ?? workPackage._embedded?.project?.name;
  const status = linkTitle(workPackage._links, 'status');
  const language: Language =
    workPackage.subject !== undefined && project !== undefined && status !== undefined
      ? 'en'
      : toLanguage((await getPreferences(assigneeId)).locale.language);
  const payload = {
    firstName: recipient.firstName,
    taskKey: taskKeyOf(workPackage),
    subject: workPackage.subject ?? t(language, 'Work package {id}', { id }),
    projectName: project ?? t(language, 'Project'),
    status: status ?? t(language, 'Unknown'),
    url: `${env.APP_BASE_URL}/tasks/${id}`,
  };

  // The dedupe key is the pair (work package, assignee), so this is a no-op
  // for every update that leaves the assignee alone and for every redelivery.
  // "Only when the assignment changes" falls out of that without a diff.
  const assigned = selfAssignedOnCreate
    ? 'opted-out'
    : await enqueueEmail({
        recipientId: assigneeId,
        template: 'task-assigned',
        payload,
        channel: 'immediate',
        dedupeKey: `assigned:${id}:${assigneeId}`,
        gate: 'assigned',
      });

  // An update that was the assignment itself has just been sent; anything
  // else on an assigned work package waits for the digest.
  if (action === 'work_package:updated' && assigned !== 'queued') {
    await enqueueEmail({
      recipientId: assigneeId,
      template: 'task-updated',
      payload,
      channel: 'digest',
      dedupeKey: `updated:${id}:${workPackage.updatedAt ?? Date.now()}`,
      gate: 'updates',
    });
  }
}

export const webhooksRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = raw;

    try {
      done(null, raw.length > 0 ? JSON.parse(raw) : {});
    } catch (error) {
      // Without a status the app's error handler would report this as a
      // server fault; it is the sender's.
      const invalid = error instanceof Error ? error : new Error('The body was not valid JSON.');
      (invalid as Error & { statusCode?: number }).statusCode = 400;
      done(invalid, undefined);
    }
  });

  const receive = async (request: FastifyRequest<{ Body: WebhookBody }>, reply: FastifyReply) => {
    verifySignature(request);
    noteWebhookReceived();

    const action = request.body?.action ?? '';
    const outcome = await receiveEvent({ source: 'openproject', eventKey: eventKeyOf(request.rawBody ?? ''), action, payload: request.body ?? {} });
    if (outcome.status === 'failed' || outcome.status === 'dead') {
      request.log.warn({ action, event: outcome.id, status: outcome.status }, 'Webhook processing failed; kept for a retry');
    }
    reply.code(204);
  };

  // `/webhooks/delivery` is the address to give the instance's webhook. The
  // older one is still accepted, so a webhook already pointed there keeps
  // arriving until someone changes its URL.
  app.post<{ Body: WebhookBody }>('/webhooks/delivery', receive);
  app.post<{ Body: WebhookBody }>('/webhooks/openproject', receive);
};

/**
 * What a delivery does, once it is in the inbox: run first on arrival, again
 * on a retry or a replay. Throws when something failed, so it is retried.
 */
export async function processOpenProjectEvent(action: string, payload: unknown, meta?: { receivedAt: Date }): Promise<void> {
  const body = (payload ?? {}) as WebhookBody;

  // For the rules (BR-216): the same change EPM made itself is keyed on the
  // same lockVersion and so considered once.
  const workPackage = body.work_package;
  if ((action === 'work_package:created' || action === 'work_package:updated') && typeof workPackage?.id === 'number') {
    await noteRuleEvent({
      source: 'webhook',
      kind: action === 'work_package:created' ? 'work_package.created' : 'work_package.updated',
      subjectType: 'work_package',
      subjectId: String(workPackage.id),
      projectId: linkId(workPackage._links, 'project'),
      version: typeof workPackage.lockVersion === 'number' ? workPackage.lockVersion : undefined,
    });
  } else if ((action === 'project:created' || action === 'project:updated') && typeof body.project?.id === 'number') {
    const id = String(body.project.id);
    await noteRuleEvent({
      source: 'webhook',
      kind: action === 'project:created' ? 'project.created' : 'project.updated',
      subjectType: 'project',
      subjectId: id,
      projectId: id,
      at: meta?.receivedAt,
    });
  }

  // Before anything that can fail: a delivery that changes a project's
  // health is worth a recalculation whatever happens to its email.
  const projectId = healthRelevantProject(action, body);
  if (projectId) {
    if (action.startsWith('time_entry:')) invalidateProjectCost(projectId);
    requestHealthRecalc(projectId);
  }
  // A work package created or changed upstream can move float anywhere its
  // relations reach; the pass works out whether it did.
  if (action.startsWith('work_package:')) requestScheduleRecalc();
  // Calculated fields read work packages and the time logged on them.
  if (action.startsWith('work_package:') || action.startsWith('time_entry:')) requestCalculatedRecalc();

  // A failure here throws, and the inbox retries the event.
  if (HANDLED_ACTIONS.has(action)) await handleWorkPackage(action, body, appLog);
}

registerProcessor('openproject', processOpenProjectEvent);
