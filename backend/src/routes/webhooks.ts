import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { env } from '../config/env.js';
import { enqueueEmail } from '../email/outbox.js';
import { resolveRecipient } from '../email/recipients.js';
import { EpmError } from '../lib/errors.js';
import { linkId, linkTitle } from '../openproject/client.js';
import type { HalLinks } from '../openproject/types.js';

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
 * retries a non-2xx and disables a webhook that keeps failing, so a bug in
 * the handler is logged and answered 204 rather than allowed to switch the
 * integration off.
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
  updatedAt?: string;
  _links?: HalLinks;
  _embedded?: { project?: { identifier?: string; name?: string } };
}

interface WebhookBody {
  action?: string;
  work_package?: WebhookWorkPackage;
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

async function handleWorkPackage(action: string, body: WebhookBody, log: FastifyBaseLogger): Promise<void> {
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

  const payload = {
    firstName: recipient.firstName,
    taskKey: taskKeyOf(workPackage),
    subject: workPackage.subject ?? `Work package ${id}`,
    projectName: linkTitle(workPackage._links, 'project') ?? workPackage._embedded?.project?.name ?? 'Project',
    status: linkTitle(workPackage._links, 'status') ?? 'Unknown',
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

  app.post<{ Body: WebhookBody }>('/webhooks/openproject', async (request, reply) => {
    verifySignature(request);

    const action = request.body?.action ?? '';

    if (HANDLED_ACTIONS.has(action)) {
      try {
        await handleWorkPackage(action, request.body, request.log);
      } catch (error) {
        request.log.warn({ err: error, action }, 'Webhook handling failed; delivery acknowledged anyway');
      }
    } else {
      request.log.debug({ action }, 'Webhook action ignored');
    }

    reply.code(204);
  });
};
