import {
  button,
  escape,
  layout,
  muted,
  paragraph,
  paragraphHtml,
  textBody,
  type EmailLocale,
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
  /**
   * ISO date. Written out in the reader's language and calendar, as the day it
   * is; the reader's own zone is not knowable here.
   */
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

function describeLate(item: DueItem, today: string, locale: EmailLocale): string {
  const days = daysLate(item.dueDate, today);
  if (days <= 0) return locale.tr('due {date}', { date: locale.date(item.dueDate) });
  return locale.tr('{days, plural, one {# day overdue} other {# days overdue}}', { days });
}

function describeSoon(item: DueItem, today: string, locale: EmailLocale): string {
  const days = -daysLate(item.dueDate, today);
  if (days <= 0) return locale.tr('due today');
  return locale.tr('{days, plural, =1 {due tomorrow} other {due in # days}}', { days });
}

/** One item in the text version: key, subject, and where and when in brackets. */
function textLine(item: DueItem, when: string, locale: EmailLocale): string {
  return `  ${locale.tr('{key} - {subject} ({project}, {when})', {
    key: item.taskKey,
    subject: item.subject,
    project: item.projectName,
    when,
  })}`;
}

export function render(payload: TaskDuePayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const today = new Date().toISOString().slice(0, 10);
  const late = payload.overdue.length;
  const soon = payload.soon.length;
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');
  const lateHeading = tr('{count, plural, one {# item is past their due date.} other {# items are past their due date.}}', {
    count: late,
  });
  const soonHeading = tr('{count, plural, one {# item is due shortly.} other {# items are due shortly.}}', { count: soon });

  // The subject is the whole message for anyone reading a notification bar, so
  // it leads with the count that matters rather than a fixed phrase.
  const subject =
    late > 0
      ? soon > 0
        ? tr('{late, plural, one {# overdue item} other {# overdue items}} and {soon, number} due soon', { late, soon })
        : tr('{count, plural, one {# overdue item} other {# overdue items}}', { count: late })
      : tr('{count, plural, one {# item due soon} other {# items due soon}}', { count: soon });

  const html = layout(
    subject,
    paragraph(greeting) +
      (late > 0
        ? paragraph(lateHeading) +
          payload.overdue.map((item) => line(item, describeLate(item, today, locale))).join('')
        : '') +
      (soon > 0
        ? paragraph(soonHeading) +
          payload.soon.map((item) => line(item, describeSoon(item, today, locale))).join('')
        : '') +
      button(tr('Open my work'), payload.url) +
      muted(tr('You can turn these reminders off in Settings.')),
    locale,
  );

  const text = textBody(
    [
      greeting,
      '',
      ...(late > 0
        ? [
            lateHeading,
            ...payload.overdue.map((item) => textLine(item, describeLate(item, today, locale), locale)),
            '',
          ]
        : []),
      ...(soon > 0
        ? [
            soonHeading,
            ...payload.soon.map((item) => textLine(item, describeSoon(item, today, locale), locale)),
            '',
          ]
        : []),
      payload.url,
      '',
      tr('You can turn these reminders off in Settings.'),
    ],
    locale,
  );

  return { subject, html, text };
}
