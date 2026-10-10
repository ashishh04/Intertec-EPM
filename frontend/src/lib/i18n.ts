import { formatMessage, type MessageParams } from './messageformat';

/**
 * EPM's interface language (BR-605) and the conventions that go with it (BR-607).
 *
 * Messages are keyed by their English text: `t('Save changes')`. The English is
 * what the code reads and what a translator is given, so there is no table of
 * invented keys to keep in step with the copy, and English needs no catalogue
 * at all. Arabic is a catalogue from English to Arabic (`src/i18n/ar.json`),
 * loaded only when somebody chooses it.
 *
 * Like the date helpers, this is module state rather than a React context:
 * `t()` is called from components, from plain functions and from constants
 * that are not components at all. `PreferenceEffects` applies the person's
 * choice and remounts the app once when it changes, which is what repaints every
 * string — the same trade the date format already makes, and for the same
 * reason: it changes once, when somebody first sets it.
 */

export type Language = 'en' | 'ar';
export type Calendar = 'gregory' | 'islamic-umalqura';
export type Numerals = 'latn' | 'arab';

export interface Conventions {
  language: Language;
  /** Gregorian, or the Umm al-Qura Hijri calendar, for every date shown. */
  calendar: Calendar;
  /** Western digits (0-9) or Arabic-Indic ones (٠-٩). */
  numerals: Numerals;
}

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'ar', label: 'العربية' },
];

const RIGHT_TO_LEFT: ReadonlySet<Language> = new Set(['ar']);

/** Any character from a right-to-left script. */
const RTL_CHARACTER = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

let conventions: Conventions = { language: 'en', calendar: 'gregory', numerals: 'latn' };
let catalogue: Readonly<Record<string, string>> = {};
const catalogues = new Map<Language, Record<string, string>>();
const reported = new Set<string>();
let numbers: Intl.NumberFormat | null = null;

/** Whatever was stored, as one of the languages EPM has. Anything else is English. */
export function toLanguage(value?: string | null): Language {
  return value?.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

export function currentLanguage(): Language {
  return conventions.language;
}

export function currentConventions(): Conventions {
  return conventions;
}

export function isRightToLeft(language: Language = conventions.language): boolean {
  return RIGHT_TO_LEFT.has(language);
}

export function direction(language: Language = conventions.language): 'rtl' | 'ltr' {
  return isRightToLeft(language) ? 'rtl' : 'ltr';
}

/**
 * The BCP 47 locale every `Intl` formatter is built with.
 *
 * English stays `en-US`, which is what the number helpers always used, so
 * nothing an English reader sees changes. Arabic is the UAE's, with the digits
 * and calendar the person chose spelled out rather than left to the locale's
 * default — which differs between browsers.
 */
export function intlLocale(current: Conventions = conventions): string {
  const base = current.language === 'ar' ? 'ar-AE' : 'en-US';
  const extensions: string[] = [];
  if (current.calendar !== 'gregory') extensions.push(`ca-${current.calendar}`);
  if (current.language !== 'en' || current.numerals !== 'latn') extensions.push(`nu-${current.numerals}`);
  return extensions.length ? `${base}-u-${extensions.join('-')}` : base;
}

/** Whether a language can be shown now, without waiting for its catalogue. */
export function isLanguageLoaded(language: Language): boolean {
  return language === 'en' || catalogues.has(language);
}

/** Fetches a language's catalogue; resolves at once for English or one already loaded. */
export async function loadLanguage(language: Language): Promise<void> {
  if (language === 'en' || catalogues.has(language)) return;
  const module = await import('@/i18n/ar.json');
  catalogues.set(language, module.default as Record<string, string>);
}

/**
 * Makes `next` current. Its catalogue must already be loaded (`loadLanguage`);
 * a language whose catalogue is missing falls back to English text rather than
 * showing keys.
 */
export function setConventions(next: Conventions): void {
  conventions = next;
  catalogue = next.language === 'en' ? {} : (catalogues.get(next.language) ?? {});
  numbers = null;
}

/** A number in the reader's digits and grouping. */
export function formatLocalNumber(value: number, options?: Intl.NumberFormatOptions): string {
  if (options) return new Intl.NumberFormat(intlLocale(), options).format(value);
  numbers ??= new Intl.NumberFormat(intlLocale());
  return numbers.format(value);
}

/**
 * Keeps an inserted value in its own direction (BR-602).
 *
 * A project called "ERP Phase 2" inside an Arabic sentence, or an Arabic name
 * inside an English one, is otherwise reordered by the surrounding text: the
 * number drifts to the wrong end and punctuation jumps sides. First-strong
 * isolation (FSI … PDI) lays the value out by its own first letter and then
 * treats it as one unit. Applied in Arabic always, and in English only to
 * values that contain right-to-left text, so English copy is untouched.
 */
export function isolate(value: string): string {
  if (!value) return value;
  if (isRightToLeft() || RTL_CHARACTER.test(value)) return `⁨${value}⁩`;
  return value;
}

/** Whether a string contains right-to-left text. */
export function hasRightToLeft(value: string): boolean {
  return RTL_CHARACTER.test(value);
}

/**
 * Translates a message and fills in its arguments.
 *
 *   t('Save changes')
 *   t('Delete {name}?', { name: project.name })
 *   t('{count, plural, one {# task} other {# tasks}}', { count })
 *
 * The message must be a literal at the call site — that is what the catalogue
 * check reads to find every string the interface can show.
 */
export function t(message: string, params?: MessageParams): string {
  let source = message;
  if (conventions.language !== 'en') {
    const translated = catalogue[message];
    if (translated !== undefined) {
      source = translated;
    } else if (import.meta.env.DEV && !reported.has(message)) {
      reported.add(message);
      console.warn(`[i18n] no ${conventions.language} translation: ${JSON.stringify(message)}`);
    }
  }
  return formatMessage(source, params, {
    locale: intlLocale(),
    number: (value) => formatLocalNumber(value),
    wrap: isolate,
  });
}

/**
 * Marks a string for translation without translating it yet: for constants
 * defined at module load, before the language is known, that are passed to
 * `t()` where they are shown. Returns its argument unchanged.
 */
export function msg<T extends string>(message: T): T {
  return message;
}
