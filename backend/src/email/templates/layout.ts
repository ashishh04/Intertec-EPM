/**
 * The one shell every EPM email is rendered into.
 *
 * Inline CSS and a fixed 600px table, because that is what mail clients
 * render consistently; a stylesheet or a flex layout is stripped or ignored
 * by enough of them to make the result unpredictable. Muted grey on white, a
 * single primary button, no images — nothing to block, nothing to load.
 *
 * Everything interpolated into HTML goes through `escape`. Subjects, names
 * and notification bodies all originate in OpenProject, where a user can type
 * a `<script>` into a work package title.
 */

import {
  intlLocale,
  isRightToLeft,
  toLanguage,
  translator,
  type Conventions,
  type Language,
} from '../../lib/i18n.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The reader's language and conventions, as the outbox stored them in the
 * payload when the email was queued (from the recipient's preferences). An
 * email with none — an external recipient, a row queued before this existed —
 * is English.
 */
export interface PayloadLocale {
  language?: string;
  calendar?: Conventions['calendar'];
  numerals?: Conventions['numerals'];
}

/** What a template needs to write for its reader (BR-605, BR-607). */
export interface EmailLocale {
  language: Language;
  dir: 'ltr' | 'rtl';
  /** Translates a message: `tr('Hi {name},', { name })`. */
  tr: ReturnType<typeof translator>;
  /** A date in the reader's language and calendar: "13 September 2026", "١٣ سبتمبر ٢٠٢٦". */
  date: (iso: string, style?: 'long' | 'weekday') => string;
}

export function emailLocale(payload: unknown): EmailLocale {
  const stored = (payload as { locale?: PayloadLocale } | null | undefined)?.locale ?? {};
  const language = toLanguage(stored.language);
  const conventions: Conventions = { calendar: stored.calendar, numerals: stored.numerals };
  return {
    language,
    dir: isRightToLeft(language) ? 'rtl' : 'ltr',
    tr: translator(language, conventions),
    date: (iso, style = 'long') => {
      const date = new Date(ISO_DAY.test(iso) ? `${iso}T00:00:00Z` : iso);
      if (Number.isNaN(date.getTime())) return iso;
      // English mail has always written "17 October 2026"; the US locale the
      // numbers use would turn it into "October 17, 2026".
      const english = language === 'en' && (conventions.calendar ?? 'gregory') === 'gregory';
      return new Intl.DateTimeFormat(english ? 'en-GB' : intlLocale(language, conventions), {
        ...(style === 'weekday' ? { weekday: 'long' as const } : {}),
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(date);
    },
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** For a caller rendering without a payload locale. */
export const ENGLISH: EmailLocale = emailLocale(undefined);

const PRIMARY = '#155EEF';
const INK = '#1F2937';
const MUTED = '#6B7280';
const RULE = '#E5E7EB';

export function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A paragraph of body copy. Text is escaped here; pass it raw. */
export function paragraph(text: string): string {
  return `<p style="margin:0 0 16px 0;font-size:15px;line-height:22px;color:${INK};">${escape(text)}</p>`;
}

/** The same paragraph style, for HTML already assembled from escaped parts. */
export function paragraphHtml(inner: string): string {
  return `<p style="margin:0 0 16px 0;font-size:15px;line-height:22px;color:${INK};">${inner}</p>`;
}

export function muted(text: string): string {
  return `<p style="margin:0 0 12px 0;font-size:13px;line-height:20px;color:${MUTED};">${escape(text)}</p>`;
}

/** The primary action. One per email, and always the thing the subject is about. */
export function button(label: string, href: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;">` +
    `<tr><td style="border-radius:6px;background:${PRIMARY};">` +
    `<a href="${escape(href)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;` +
    `line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:6px;">${escape(label)}</a>` +
    `</td></tr></table>`
  );
}

/** A plain link, for the "if the button does not work" line. */
export function link(href: string, label = href): string {
  return `<a href="${escape(href)}" style="color:${PRIMARY};text-decoration:underline;word-break:break-all;">${escape(label)}</a>`;
}

/** One entry in a list of items, as the digest renders them. */
export function listItem(title: string, body: string, href?: string): string {
  const heading = href
    ? `<a href="${escape(href)}" style="color:${INK};font-weight:600;text-decoration:none;">${escape(title)}</a>`
    : `<span style="color:${INK};font-weight:600;">${escape(title)}</span>`;

  return (
    `<tr><td style="padding:12px 0;border-bottom:1px solid ${RULE};">` +
    `<div style="font-size:15px;line-height:22px;">${heading}</div>` +
    (body ? `<div style="font-size:13px;line-height:20px;color:${MUTED};margin-top:2px;">${escape(body)}</div>` : '') +
    `</td></tr>`
  );
}

export function list(rows: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px 0;border-top:1px solid ${RULE};">${rows}</table>`;
}

/**
 * Wraps rendered body HTML in the branded shell. `title` becomes the document
 * title and the preheader, the line clients show beside the subject.
 */
export function layout(title: string, bodyHtml: string, locale: EmailLocale = ENGLISH): string {
  // Right to left for an Arabic reader: the document's direction, and an
  // explicit alignment on every cell, because several clients ignore `dir`
  // inside a table. Tahoma and Segoe UI carry Arabic on the systems that read
  // mail, so the stack names them before the Latin-only faces.
  const dir = locale.dir;
  const align = dir === 'rtl' ? 'right' : 'left';
  const fonts =
    dir === 'rtl'
      ? `Tahoma,'Segoe UI',Arial,sans-serif`
      : `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
  return (
    `<!DOCTYPE html>` +
    `<html lang="${locale.language}" dir="${dir}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escape(title)}</title></head>` +
    `<body style="margin:0;padding:0;background:#F5F6F8;">` +
    `<div style="display:none;max-height:0;overflow:hidden;color:#F5F6F8;">${escape(title)}</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F5F6F8;">` +
    `<tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" dir="${dir}" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;border:1px solid ${RULE};">` +
    `<tr><td style="padding:24px 32px 8px 32px;text-align:${align};font-family:${fonts};">` +
    `<div style="font-size:18px;font-weight:700;letter-spacing:0.04em;color:${PRIMARY};">EPM</div>` +
    `</td></tr>` +
    `<tr><td style="padding:16px 32px 8px 32px;text-align:${align};font-family:${fonts};">` +
    bodyHtml +
    `</td></tr>` +
    `<tr><td style="padding:16px 32px 24px 32px;border-top:1px solid ${RULE};text-align:${align};font-family:${fonts};">` +
    `<div style="font-size:12px;line-height:18px;color:${MUTED};">${escape(locale.tr('Intertec Systems · Internal platform'))}</div>` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

/** The text alternative: the same lines, one per paragraph, no markup. */
export function textBody(lines: (string | undefined)[], locale: EmailLocale = ENGLISH): string {
  return [
    ...lines.filter((line): line is string => Boolean(line)),
    '',
    locale.tr('Intertec Systems · Internal platform'),
  ].join('\n');
}
