import {
  button,
  escape,
  layout,
  muted,
  paragraph,
  paragraphHtml,
  textBody,
  type RenderedEmail,
} from './layout.js';

/**
 * The daily deadline reminder.
 *
 * One email per person rather than one per work package: somebody with nine
 * late items does not need nine emails, and a single list is what makes the
 * shape of the problem readable. Overdue work leads, because it is the part
 * that needs a decision today.
 */
export interface DueItem {
  taskKey: string;
  subject: string;
  projectName: string;
  /** ISO date. Rendered as written; the reader's own zone is not knowable here. */
  dueDate: string;
  url: string;
}

export interface TaskDuePayload {
  firstName: string;
  overdue: DueItem[];
  soon: DueItem[];
  /** Where the whole queue lives, for the button. */
  url: string;
}

function line(item: DueItem, suffix: string): string {
  return paragraphHtml(
    `<strong>${escape(item.taskKey)}</strong> &middot; ${escape(item.subject)}<br>` +
      `<span style="color:#667085">${escape(item.projectName)} &middot; ${escape(suffix)}</span>`,
  );
}

function daysLate(dueDate: string, today: string): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.round((now - due) / 86_400_000);
}

function describeLate(item: DueItem, today: string): string {
  const days = daysLate(item.dueDate, today);
  if (days <= 0) return `due ${item.dueDate}`;
  return days === 1 ? '1 day overdue' : `${days} days overdue`;
}

function describeSoon(item: DueItem, today: string): string {
  const days = -daysLate(item.dueDate, today);
  if (days <= 0) return 'due today';
  return days === 1 ? 'due tomorrow' : `due in ${days} days`;
}

export function render(payload: TaskDuePayload): RenderedEmail {
  const today = new Date().toISOString().slice(0, 10);
  const late = payload.overdue.length;
  const soon = payload.soon.length;

  // The subject is the whole message for anyone reading a notification bar, so
  // it leads with the count that matters rather than a fixed phrase.
  const subject =
    late > 0
      ? `${late} overdue ${late === 1 ? 'item' : 'items'}${soon > 0 ? ` and ${soon} due soon` : ''}`
      : `${soon} ${soon === 1 ? 'item' : 'items'} due soon`;

  const html = layout(
    subject,
    paragraph(`Hi ${payload.firstName},`) +
      (late > 0
        ? paragraph(`${late} ${late === 1 ? 'item is' : 'items are'} past their due date.`) +
          payload.overdue.map((item) => line(item, describeLate(item, today))).join('')
        : '') +
      (soon > 0
        ? paragraph(`${soon} ${soon === 1 ? 'item is' : 'items are'} due shortly.`) +
          payload.soon.map((item) => line(item, describeSoon(item, today))).join('')
        : '') +
      button('Open my work', payload.url) +
      muted('You can turn these reminders off in Settings.'),
  );

  const text = textBody([
    `Hi ${payload.firstName},`,
    '',
    ...(late > 0
      ? [
          `${late} ${late === 1 ? 'item is' : 'items are'} past their due date.`,
          ...payload.overdue.map(
            (item) =>
              `  ${item.taskKey} - ${item.subject} (${item.projectName}, ${describeLate(item, today)})`,
          ),
          '',
        ]
      : []),
    ...(soon > 0
      ? [
          `${soon} ${soon === 1 ? 'item is' : 'items are'} due shortly.`,
          ...payload.soon.map(
            (item) =>
              `  ${item.taskKey} - ${item.subject} (${item.projectName}, ${describeSoon(item, today)})`,
          ),
          '',
        ]
      : []),
    payload.url,
    '',
    'You can turn these reminders off in Settings.',
  ]);

  return { subject, html, text };
}
