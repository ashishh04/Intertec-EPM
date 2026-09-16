import { render as digest, type DigestPayload } from './digest.js';
import { render as invite, type InvitePayload } from './invite.js';
import type { RenderedEmail } from './layout.js';
import { render as notification, type NotificationPayload } from './notification.js';
import {
  render as projectMemberAdded,
  type ProjectMemberAddedPayload,
} from './project-member-added.js';
import { render as taskAssigned, type TaskAssignedPayload } from './task-assigned.js';
import { render as taskDue, type TaskDuePayload } from './task-due.js';
import { render as taskUpdated, type TaskUpdatedPayload } from './task-updated.js';

/**
 * Template name → renderer.
 *
 * The outbox stores the name and the payload, not the rendered body: a row is
 * rendered when it is sent, so a template fix applies to anything still
 * queued, and a row can be inspected as data rather than as markup.
 */

export interface TemplatePayloads {
  invite: InvitePayload;
  'task-assigned': TaskAssignedPayload;
  'task-due': TaskDuePayload;
  'project-member-added': ProjectMemberAddedPayload;
  'task-updated': TaskUpdatedPayload;
  notification: NotificationPayload;
  digest: DigestPayload;
}

export type TemplateName = keyof TemplatePayloads;

type Renderers = { [Name in TemplateName]: (payload: TemplatePayloads[Name]) => RenderedEmail };

const renderers: Renderers = {
  invite,
  'task-assigned': taskAssigned,
  'task-due': taskDue,
  'project-member-added': projectMemberAdded,
  'task-updated': taskUpdated,
  notification,
  digest,
};

export function isTemplateName(value: string): value is TemplateName {
  return Object.hasOwn(renderers, value);
}

export function renderTemplate<Name extends TemplateName>(
  name: Name,
  payload: TemplatePayloads[Name],
): RenderedEmail {
  return renderers[name](payload);
}

/**
 * Renders a stored row, whose template name and payload are only strings and
 * JSON by the time they come back from the database.
 */
export function renderStored(name: string, payload: unknown): RenderedEmail {
  if (!isTemplateName(name)) throw new Error(`Unknown email template "${name}".`);
  if (!payload || typeof payload !== 'object') throw new Error(`Email template "${name}" has no payload.`);
  return renderers[name](payload as never);
}

export type { RenderedEmail } from './layout.js';
