import { button, layout, list, listItem, muted, paragraph, textBody, type EmailLocale, type RenderedEmail } from './layout.js';

/**
 * Sent once when one action gives someone several work packages — a bulk
 * assign — rather than one email per task: thirty tasks assigned together used
 * to be thirty emails.
 */
export interface TasksAssignedPayload {
  firstName: string;
  count: number;
  tasks: { taskKey: string; subject: string; projectName: string; url: string }[];
  /** Where all of them are: My Work. */
  url: string;
}

/** Listed in the email; any more are counted. */
const SHOWN = 25;

export function render(payload: TasksAssignedPayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const subject = tr('{count, plural, one {# work package assigned to you} other {# work packages assigned to you}}', { count: payload.count });
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');
  const shown = payload.tasks.slice(0, SHOWN);
  const more = payload.count - shown.length;

  const html = layout(
    subject,
    paragraph(greeting) +
      paragraph(tr('These work packages have been assigned to you.')) +
      list(shown.map((task) => listItem(`${task.taskKey} · ${task.subject}`, task.projectName, task.url)).join('')) +
      (more > 0 ? muted(tr('{count, plural, one {And # more.} other {And # more.}}', { count: more })) : '') +
      button(tr('Open My Work'), payload.url),
    locale,
  );

  const text = textBody(
    [
      greeting,
      '',
      tr('These work packages have been assigned to you.'),
      '',
      ...shown.map((task) => `${task.taskKey} · ${task.subject} (${task.projectName})  ${task.url}`),
      ...(more > 0 ? [tr('{count, plural, one {And # more.} other {And # more.}}', { count: more })] : []),
      '',
      payload.url,
    ],
    locale,
  );

  return { subject, html, text };
}
