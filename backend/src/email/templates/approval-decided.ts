import { button, escape, layout, muted, paragraph, paragraphHtml, textBody, type RenderedEmail } from './layout.js';

/** Sent to whoever submitted a request when it is approved or rejected. */
export interface ApprovalDecidedPayload {
  firstName: string;
  key: string;
  title: string;
  projectName: string;
  outcome: 'approved' | 'rejected';
  /** Who made the deciding call, with "on behalf of" where it was delegated. */
  decidedByText: string;
  comment?: string;
  openUrl: string;
}

export function render(payload: ApprovalDecidedPayload): RenderedEmail {
  const word = payload.outcome === 'approved' ? 'Approved' : 'Rejected';
  const subject = `[${payload.key}] ${word}: ${payload.title}`;

  const html = layout(
    subject,
    paragraph(`Hi ${payload.firstName},`) +
      paragraph(`Your approval request was ${payload.outcome}.`) +
      paragraphHtml(`<strong>${escape(payload.key)}</strong> &middot; ${escape(payload.title)}`) +
      muted(`${payload.projectName} · ${payload.decidedByText}`) +
      (payload.comment ? paragraph(`“${payload.comment}”`) : '') +
      button('Open the work package', payload.openUrl),
  );

  const text = textBody([
    `Hi ${payload.firstName},`,
    '',
    `Your approval request was ${payload.outcome}.`,
    '',
    `${payload.key} · ${payload.title}`,
    `${payload.projectName} · ${payload.decidedByText}`,
    payload.comment ? `“${payload.comment}”` : undefined,
    '',
    payload.openUrl,
  ]);

  return { subject, html, text };
}
