import { AsyncLocalStorage } from 'node:async_hooks';

import { formatMessage, type MessageParams } from './messageformat.js';
import { ar } from '../i18n/ar.js';

/**
 * EPM's languages on the server (BR-605, BR-607): error messages, emails,
 * notifications and exports.
 *
 * The same scheme as the frontend's `lib/i18n.ts`, and the same message format
 * (`lib/messageformat.ts` is a copy kept identical by `npm run types:check`):
 * a message is keyed by its English text, and Arabic is a catalogue from English
 * to Arabic (`src/i18n/ar.ts`). What differs is where the language comes from.
 * A browser says which language it is showing on every request
 * (`Accept-Language`); an email or a notification is written for its recipient,
 * from their saved preference, because nobody is asking at the time.
 */

export type Language = 'en' | 'ar';

const CATALOGUES: Record<Exclude<Language, 'en'>, Readonly<Record<string, string>>> = { ar };

/** Any character from a right-to-left script. */
const RTL_CHARACTER = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/**
 * A message and its arguments, held until it is known who will read it.
 *
 * Code that raises an error or queues a notification usually does not know the
 * reader's language; it builds one of these, and the edge — the error handler,
 * the email renderer — writes it out in the right language. An argument may
 * itself be a message: "{what} could not be found." takes "That project" as a
 * phrase to translate, not as data.
 */
export interface Message {
  readonly template: string;
  readonly params?: Readonly<Record<string, ParamValue>>;
}

export type ParamValue = string | number | boolean | null | undefined | Message | ListParam | DateParam | MoneyParam;

/**
 * A calendar date as an argument, written in the reader's language, digits and
 * calendar when the message is: "13 Oct 2026" in English, "١٣ أكتوبر ٢٠٢٦" or a
 * Hijri date in Arabic. English keeps the server's house style (en-GB), which
 * is what every stored English sentence has always used.
 */
export interface DateParam {
  readonly date: string;
  readonly style?: 'short' | 'long';
}

/** An amount of money as an argument, in the reader's currency format. */
export interface MoneyParam {
  readonly money: number;
  readonly currency: string;
}

export function dateOf(iso: string, style: DateParam['style'] = 'short'): DateParam {
  return { date: iso, style };
}

export function moneyOf(amount: number, currency: string): MoneyParam {
  return { money: amount, currency };
}

function isDate(value: unknown): value is DateParam {
  return typeof value === 'object' && value !== null && typeof (value as DateParam).date === 'string';
}

function isMoney(value: unknown): value is MoneyParam {
  return typeof value === 'object' && value !== null && typeof (value as MoneyParam).money === 'number';
}

/**
 * Several values as one argument — "needs a first name, a last name and an
 * email address". Each item is translated like any argument, and the items are
 * joined the way the language joins them: ", " or " and " in English, "، " or
 * " و" in Arabic.
 */
export interface ListParam {
  readonly list: readonly ParamValue[];
  readonly joiner: 'comma' | 'and';
}

export function message(template: string, params?: Record<string, ParamValue>): Message {
  return params ? { template, params } : { template };
}

/**
 * Marks a phrase that reaches a message as an argument — a field name, a
 * permission, a password rule — so the translation check knows it needs an
 * entry. Returns its argument unchanged; `t()` translates string arguments that
 * are catalogue entries.
 */
export function msg<T extends string>(phrase: T): T {
  return phrase;
}

export function listOf(list: readonly ParamValue[], joiner: 'comma' | 'and' = 'comma'): ListParam {
  return { list, joiner };
}

export function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && typeof (value as Message).template === 'string';
}

function isList(value: unknown): value is ListParam {
  return typeof value === 'object' && value !== null && Array.isArray((value as ListParam).list);
}

const JOINERS: Record<Language, Record<ListParam['joiner'], string>> = {
  en: { comma: ', ', and: ' and ' },
  ar: { comma: '، ', and: ' و' },
};

/** Whatever was stored or sent, as one of the languages EPM has. Anything else is English. */
export function toLanguage(value?: string | null): Language {
  return value?.trim().toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

export function isRightToLeft(language: Language): boolean {
  return language === 'ar';
}

export interface Conventions {
  calendar?: 'gregory' | 'islamic-umalqura';
  numerals?: 'latn' | 'arab';
}

/** The BCP 47 locale for `Intl`, as the frontend builds it. */
export function intlLocale(language: Language, conventions: Conventions = {}): string {
  const calendar = conventions.calendar ?? 'gregory';
  const numerals = conventions.numerals ?? 'latn';
  const base = language === 'ar' ? 'ar-AE' : 'en-US';
  const extensions: string[] = [];
  if (calendar !== 'gregory') extensions.push(`ca-${calendar}`);
  if (language !== 'en' || numerals !== 'latn') extensions.push(`nu-${numerals}`);
  return extensions.length ? `${base}-u-${extensions.join('-')}` : base;
}

/** Keeps an inserted value in its own direction (BR-602); see the frontend's `isolate`. */
export function isolate(language: Language, value: string): string {
  if (!value) return value;
  if (isRightToLeft(language) || RTL_CHARACTER.test(value)) return `⁨${value}⁩`;
  return value;
}

/** The catalogue entry for `source`, or `source` itself. */
function lookup(language: Language, source: string): string {
  return language === 'en' ? source : (CATALOGUES[language][source] ?? source);
}

/**
 * Translates `source` into `language` and fills in its arguments. String
 * arguments that are themselves catalogue entries are translated too, which is
 * how a phrase passed as an argument ("That project") reads naturally in the
 * sentence around it; anything else — a name, an id — is inserted as it is.
 *
 * A string argument is translated as it is inserted, not before: a `select`
 * chooses its branch by the argument's own value, and that value must not
 * have been turned into Arabic first.
 */
export function t(
  language: Language,
  source: string,
  params?: Readonly<Record<string, ParamValue>>,
  conventions: Conventions = {},
): string {
  const one = (value: ParamValue, insideList = false): string | number | boolean | null | undefined => {
    if (isMessage(value)) return t(language, value.template, value.params, conventions);
    if (isDate(value)) return formatDate(language, value, conventions);
    if (isMoney(value)) return formatMoney(language, value, conventions);
    if (isList(value)) {
      return value.list.map((item) => String(one(item, true) ?? '')).join(JOINERS[language][value.joiner]);
    }
    // A list's items are joined here, so they are translated here.
    if (typeof value === 'string' && insideList) return lookup(language, value);
    return value;
  };
  const resolved: MessageParams = {};
  for (const [key, value] of Object.entries(params ?? {})) resolved[key] = one(value);
  const locale = intlLocale(language, conventions);
  return formatMessage(lookup(language, source), resolved, {
    locale,
    number: (value) => new Intl.NumberFormat(locale).format(value),
    wrap: (value) => isolate(language, lookup(language, value)),
  });
}

function formatDate(language: Language, value: DateParam, conventions: Conventions): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value.date) ? `${value.date}T00:00:00Z` : value.date);
  if (Number.isNaN(date.getTime())) return value.date;
  const locale = language === 'en' && (conventions.calendar ?? 'gregory') === 'gregory' ? 'en-GB' : intlLocale(language, conventions);
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: value.style === 'long' ? 'long' : 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatMoney(language: Language, value: MoneyParam, conventions: Conventions): string {
  return new Intl.NumberFormat(intlLocale(language, conventions), {
    style: 'currency',
    currency: value.currency,
    maximumFractionDigits: 0,
  }).format(value.money);
}

/** A message, or plain text, written out in `language`. */
export function render(language: Language, value: Message | string, conventions: Conventions = {}): string {
  return typeof value === 'string' ? t(language, value, undefined, conventions) : t(language, value.template, value.params, conventions);
}

/** A translator bound to one language: `const tr = translator('ar'); tr('Save')`. */
export function translator(language: Language, conventions: Conventions = {}) {
  return (source: string, params?: Readonly<Record<string, ParamValue>>) => t(language, source, params, conventions);
}

/**
 * One validation problem, in `language`.
 *
 * A message the schema wrote itself ("Choose a start date") is translated like
 * any other. Zod's own defaults ("Expected string, received number") are
 * developer English with values baked in, so in another language each kind of
 * problem gets one plain sentence instead; the field it concerns is in `path`
 * beside it.
 */
export function issueMessage(
  language: Language,
  issue: { code: string; message: string; received?: unknown },
): string {
  if (language === 'en') return issue.message;
  const own = lookup(language, issue.message);
  if (own !== issue.message) return own;
  switch (issue.code) {
    case 'invalid_type':
      return t(language, issue.received === 'undefined' ? 'This is required.' : 'This value is not the right type.');
    case 'too_small':
      return t(language, 'This value is too short or too small.');
    case 'too_big':
      return t(language, 'This value is too long or too large.');
    case 'invalid_string':
      return t(language, 'This value is not in the right format.');
    case 'invalid_enum_value':
      return t(language, 'This is not one of the allowed values.');
    case 'invalid_date':
      return t(language, 'This is not a valid date.');
    default:
      return t(language, 'This value is not valid.');
  }
}

const requestLanguages = new AsyncLocalStorage<Language>();

/** Serves `fn` in `language`: everything it calls can ask `contextLanguage()`. */
export function runWithLanguage<T>(language: Language, fn: () => T): T {
  return requestLanguages.run(language, fn);
}

/**
 * The language of the request being served — for code far from the request
 * that writes stored English out for a reader (a journal entry, a health
 * reason). English outside a request: a scheduler or an email chooses its
 * reader's language itself.
 */
export function contextLanguage(): Language {
  return requestLanguages.getStore() ?? 'en';
}

/** Stored English, or its message when one was kept, in the current request's language. */
export function renderStored(english: string, stored: unknown): string {
  if (!isMessage(stored)) return english;
  const language = contextLanguage();
  return language === 'en' ? english : render(language, stored);
}

/**
 * The language a request asked for. The frontend sends the language it is
 * showing as `Accept-Language`; a caller that sends none, or one EPM does not
 * have, gets English.
 */
export function requestLanguage(request: { headers: Record<string, string | string[] | undefined> }): Language {
  const header = request.headers['accept-language'];
  const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.split(';')[0];
  return toLanguage(first);
}
