import {
  button,
  escape,
  layout,
  link,
  muted,
  paragraph,
  paragraphHtml,
  textBody,
  type EmailLocale,
  type RenderedEmail,
} from './layout.js';

/**
 * Sent when an approval step reaches someone (BR-215).
 *
 * Both links open EPM, ask the person to sign in if they are not, show what
 * they are deciding and only then decide — a link that decided on the click
 * itself would be decided by the mail scanners that open every link in a
 * message before anybody reads it. Each link works once, and only for the
 * person it was sent to.
 */
export interface ApprovalRequestPayload {
  firstName: string;
  key: string;
  title: string;
  projectName: string;
  stepName: string;
  requesterName: string;
  /** The value the chain is decided on, when it has one. */
  value?: number;
  /** The chain's name for that value ("Change value"); "Value" when it has none. */
  valueLabel?: string;
  /** "Change value: 75,000", in English: rows queued before `value` carry this instead. */
  valueText?: string;
  /** Set when this person decides as a delegate: whose approval it is. */
  onBehalfOfName?: string;
  /** When the step's SLA runs out, ISO, when the step has one. */
  dueAt?: string;
  /** "Due by 2026-10-08 14:00 UTC", in English: rows queued before `dueAt` carry this instead. */
  dueText?: string;
  approveUrl: string;
  rejectUrl: string;
  openUrl: string;
  /** What is being approved; a work package when absent (rows queued before Module 10). */
  subjectKind?: 'work_package' | 'timesheet' | 'expense_claim' | 'scenario';
}

/**
 * Stand in for the two links while the sentence around them is translated and
 * escaped, so each can then be put wherever the language puts it. Private-use
 * characters: no translation contains them.
 */
const REJECT = '\u{E000}';
const OPEN = '\u{E001}';

export function render(payload: ApprovalRequestPayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const subject = tr('[{key}] Approval needed: {title}', { key: payload.key, title: payload.title });
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');
  const asked = payload.onBehalfOfName
    ? tr('{requester} needs your approval on behalf of {approver} at the "{step}" step.', {
        requester: payload.requesterName,
        approver: payload.onBehalfOfName,
        step: payload.stepName,
      })
    : tr('{requester} needs your approval at the "{step}" step.', {
        requester: payload.requesterName,
        step: payload.stepName,
      });
  const value =
    typeof payload.value === 'number'
      ? payload.valueLabel
        ? tr('{label}: {value, number}', { label: payload.valueLabel, value: payload.value })
        : tr('Value: {value, number}', { value: payload.value })
      : payload.valueText;
  const due = payload.dueAt
    ? tr('Due by {date} at {time} UTC', { date: locale.date(payload.dueAt), time: payload.dueAt.slice(11, 16) })
    : payload.dueText;
  const facts = [payload.projectName, value, due].filter(Boolean).join(' · ');
  const once = tr('Each link works once, and only when you are signed in as yourself. Nothing is decided until you confirm.');

  const html = layout(
    subject,
    paragraph(greeting) +
      paragraph(asked) +
      paragraphHtml(`<strong>${escape(payload.key)}</strong> &middot; ${escape(payload.title)}`) +
      muted(facts) +
      button(tr('Review and approve'), payload.approveUrl) +
      paragraphHtml(
        escape(tr('Or {reject}, or {open}.', { reject: REJECT, open: OPEN }))
          .replace(REJECT, () => link(payload.rejectUrl, tr('review and reject')))
          .replace(OPEN, () =>
            link(
              payload.openUrl,
              payload.subjectKind === 'timesheet'
                ? tr('open the timesheet')
                : payload.subjectKind === 'expense_claim'
                  ? tr('open the claim')
                  : payload.subjectKind === 'scenario'
                    ? tr('open the scenario')
                    : tr('open the work package'),
            ),
          ),
      ) +
      muted(once),
    locale,
  );

  // The addresses stay out of the translated text: a link that a mail client
  // reads with a direction mark stuck to its end no longer works.
  const text = textBody(
    [
      greeting,
      '',
      asked,
      '',
      `${payload.key} · ${payload.title}`,
      facts,
      '',
      `${tr('Approve:')} ${payload.approveUrl}`,
      `${tr('Reject:')} ${payload.rejectUrl}`,
      `${tr('Open:')} ${payload.openUrl}`,
      '',
      once,
    ],
    locale,
  );

  return { subject, html, text };
}
