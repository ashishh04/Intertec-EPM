import { env } from '../config/env.js';
import { enqueueEmail, type EnqueueOutcome } from '../email/outbox.js';
import { getPreferences } from '../email/preferences.js';
import { resolveRecipient, type Recipient } from '../email/recipients.js';
import { t, toLanguage, type Language } from '../lib/i18n.js';
import { appLog } from '../lib/log.js';
import { linkId, linkTitle } from '../openproject/client.js';
import type { HalLinks } from '../openproject/types.js';

/**
 * Telling someone that a task is now theirs.
 *
 * This used to happen only when the delivery system called EPM back through its
 * webhook. A deployment without that webhook — which the deployment notes call
 * optional, and which the shared server never had — therefore sent no
 * assignment email at all, while invitations, which EPM sends itself, arrived:
 * exactly "only the invitations are delivered". So every write EPM makes that
 * can set an assignee now says so here, and the webhook stays as the path for
 * changes made elsewhere. Both key the email on (work package, assignee), so
 * whichever arrives second is a no-op rather than a second email.
 */

/** A work package as a write returns it, or as a webhook delivers it. HAL either way. */
export interface AssignedWork {
  id: number | string;
  subject?: string;
  updatedAt?: string;
  _links?: HalLinks | Record<string, { href?: string | null; title?: string } | undefined>;
  _embedded?: { project?: { identifier?: string; name?: string } };
}

/** The same key the task mapping shows: `IDENT-123`, or `WP-123` without an identifier. */
export function taskKeyOf(id: number | string, identifier: string | undefined): string {
  return identifier ? `${identifier.slice(0, 6).toUpperCase()}-${id}` : `WP-${id}`;
}

/**
 * The assignment email's payload.
 *
 * What stands in for a name the work package did not carry is written in the
 * language the email will be — the assignee's, from their preferences, as the
 * outbox reads it — and that is only looked up when something is missing.
 */
export async function assignmentPayload(
  workPackage: AssignedWork,
  assigneeId: string,
  recipient: Recipient,
  identifier?: string,
) {
  const links = workPackage._links as HalLinks | undefined;
  const id = String(workPackage.id);
  const project = linkTitle(links, 'project') ?? workPackage._embedded?.project?.name;
  const status = linkTitle(links, 'status');
  const language: Language =
    workPackage.subject !== undefined && project !== undefined && status !== undefined
      ? 'en'
      : toLanguage((await getPreferences(assigneeId)).locale.language);

  return {
    firstName: recipient.firstName,
    taskKey: taskKeyOf(id, identifier ?? workPackage._embedded?.project?.identifier),
    subject: workPackage.subject ?? t(language, 'Work package {id}', { id }),
    projectName: project ?? t(language, 'Project'),
    status: status ?? t(language, 'Unknown'),
    url: `${env.APP_BASE_URL}/tasks/${id}`,
  };
}

/**
 * Mails the assignee about a write EPM has just made.
 *
 * - A new work package with an assignee, or an edit that changed the assignee:
 *   the assignment email, at once (the "assigned" switch in their settings).
 * - Any other edit of a work package assigned to somebody: a line in their
 *   daily digest (the "updates" switch).
 * - Nobody is told about their own doing: assigning yourself, or editing work
 *   that is already yours, is not news to you.
 *
 * Never throws. The write has already happened; an email is a side effect of it
 * and must not turn a saved task into an error.
 */
export async function tellAssignee(input: {
  workPackage: AssignedWork;
  event: 'created' | 'updated';
  /** Who made the change. */
  actorId?: string;
  /** For an edit: whom the work package was assigned to before it. */
  previousAssigneeId?: string;
  /** The project's identifier, for the task key. */
  identifier?: string;
}): Promise<EnqueueOutcome | 'skipped'> {
  try {
    const links = input.workPackage._links as HalLinks | undefined;
    const assigneeId = linkId(links, 'assignee');
    if (!assigneeId) return 'skipped';
    if (input.actorId && input.actorId === assigneeId) return 'skipped';

    const recipient = await resolveRecipient(assigneeId);
    if (!recipient) return 'skipped';

    const id = String(input.workPackage.id);
    const payload = await assignmentPayload(input.workPackage, assigneeId, recipient, input.identifier);
    const assigned = input.event === 'created' || input.previousAssigneeId !== assigneeId;

    if (assigned) {
      // Keyed on the pair, like the webhook's copy, so the two never both send.
      return await enqueueEmail({
        recipientId: assigneeId,
        template: 'task-assigned',
        payload,
        channel: 'immediate',
        dedupeKey: `assigned:${id}:${assigneeId}`,
        gate: 'assigned',
      });
    }

    return await enqueueEmail({
      recipientId: assigneeId,
      template: 'task-updated',
      payload,
      channel: 'digest',
      dedupeKey: `updated:${id}:${input.workPackage.updatedAt ?? Date.now()}`,
      gate: 'updates',
    });
  } catch (error) {
    appLog.warn({ err: error, workPackageId: String(input.workPackage.id) }, 'Could not tell the assignee');
    return 'error';
  }
}

/** The assignee a work package names, for comparing before and after an edit. */
export function assigneeOf(workPackage: AssignedWork | null | undefined): string | undefined {
  return workPackage ? linkId(workPackage._links as HalLinks | undefined, 'assignee') : undefined;
}
