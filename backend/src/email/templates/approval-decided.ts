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

/** Sent to whoever submitted a request when it is approved or rejected. */
export interface ApprovalDecidedPayload {
  firstName: string;
  key: string;
  title: string;
  projectName: string;
  outcome: 'approved' | 'rejected';
  /** Who made the deciding call. */
  decidedBy?: string;
  /** Whose approval it was, when the deciding call was made as their delegate. */
  onBehalfOf?: string;
  /** "Decided by …", in English: rows queued before `decidedBy` carry this instead. */
  decidedByText?: string;
  comment?: string;
  openUrl: string;
  /** What was decided; a work package when absent (rows queued before Module 10). */
  subjectKind?: 'work_package' | 'timesheet' | 'expense_claim';
}

export function render(payload: ApprovalDecidedPayload, locale: EmailLocale): RenderedEmail {
  const { tr } = locale;
  const subject = tr('[{key}] {outcome, select, approved {Approved} other {Rejected}}: {title}', {
    key: payload.key,
    outcome: payload.outcome,
    title: payload.title,
  });
  const greeting = payload.firstName ? tr('Hi {name},', { name: payload.firstName }) : tr('Hello,');
  const decided = tr('Your approval request was {outcome, select, approved {approved} other {rejected}}.', {
    outcome: payload.outcome,
  });
  const decidedBy =
    payload.decidedBy === undefined
      ? `${payload.projectName} · ${payload.decidedByText ?? ''}`
      : payload.onBehalfOf
        ? tr('{project} · Decided by {name} on behalf of {approver}', {
            project: payload.projectName,
            name: payload.decidedBy,
            approver: payload.onBehalfOf,
          })
        : tr('{project} · Decided by {name}', { project: payload.projectName, name: payload.decidedBy });
  const comment = payload.comment ? tr('“{comment}”', { comment: payload.comment }) : undefined;

  const html = layout(
    subject,
    paragraph(greeting) +
      paragraph(decided) +
      paragraphHtml(`<strong>${escape(payload.key)}</strong> &middot; ${escape(payload.title)}`) +
      muted(decidedBy) +
      (comment ? paragraph(comment) : '') +
      button(
        payload.subjectKind === 'timesheet'
          ? tr('Open the timesheet')
          : payload.subjectKind === 'expense_claim'
            ? tr('Open the claim')
            : tr('Open the work package'),
        payload.openUrl,
      ),
    locale,
  );

  const text = textBody(
    [
      greeting,
      '',
      decided,
      '',
      `${payload.key} · ${payload.title}`,
      decidedBy,
      comment,
      '',
      payload.openUrl,
    ],
    locale,
  );

  return { subject, html, text };
}
