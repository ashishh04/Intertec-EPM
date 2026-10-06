import { button, escape, layout, link, muted, paragraph, paragraphHtml, textBody, type RenderedEmail } from './layout.js';

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
  /** "Change value: 75,000", when the chain has a value. */
  valueText?: string;
  /** Set when this person decides as a delegate: whose approval it is. */
  onBehalfOfName?: string;
  /** "Due by 8 Oct 2026, 14:00 UTC", when the step has an SLA. */
  dueText?: string;
  approveUrl: string;
  rejectUrl: string;
  openUrl: string;
}

export function render(payload: ApprovalRequestPayload): RenderedEmail {
  const subject = `[${payload.key}] Approval needed: ${payload.title}`;
  const whose = payload.onBehalfOfName ? ` on behalf of ${payload.onBehalfOfName}` : '';

  const html = layout(
    subject,
    paragraph(`Hi ${payload.firstName},`) +
      paragraph(`${payload.requesterName} needs your approval${whose} at the "${payload.stepName}" step.`) +
      paragraphHtml(`<strong>${escape(payload.key)}</strong> &middot; ${escape(payload.title)}`) +
      muted([payload.projectName, payload.valueText, payload.dueText].filter(Boolean).join(' · ')) +
      button('Review and approve', payload.approveUrl) +
      paragraphHtml(`Or ${link(payload.rejectUrl, 'review and reject')}, or ${link(payload.openUrl, 'open the work package')}.`) +
      muted('Each link works once, and only when you are signed in as yourself. Nothing is decided until you confirm.'),
  );

  const text = textBody([
    `Hi ${payload.firstName},`,
    '',
    `${payload.requesterName} needs your approval${whose} at the "${payload.stepName}" step.`,
    '',
    `${payload.key} · ${payload.title}`,
    [payload.projectName, payload.valueText, payload.dueText].filter(Boolean).join(' · '),
    '',
    `Approve: ${payload.approveUrl}`,
    `Reject: ${payload.rejectUrl}`,
    `Open: ${payload.openUrl}`,
    '',
    'Each link works once, and only when you are signed in as yourself. Nothing is decided until you confirm.',
  ]);

  return { subject, html, text };
}
