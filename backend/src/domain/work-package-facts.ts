import type { HalLink } from '../openproject/types.js';

/**
 * A work package's custom fields as comparable facts: each as a number where
 * it is one, and always as the text a person sees — list, user and version
 * fields are links with a title. Approval conditions and rule conditions read
 * custom fields the same way, so they agree on what a field holds.
 */
export function customFieldFacts(workPackage: {
  _links?: Record<string, HalLink | HalLink[] | undefined>;
  [field: string]: unknown;
}): Record<string, { texts: string[]; number?: number }> {
  const facts: Record<string, { texts: string[]; number?: number }> = {};
  for (const [field, value] of Object.entries(workPackage)) {
    if (!/^customField\d+$/.test(field) || value === null || value === undefined) continue;
    if (typeof value === 'number') facts[field] = { number: value, texts: [String(value)] };
    else if (typeof value === 'string' || typeof value === 'boolean') facts[field] = { texts: [String(value)] };
    else if (typeof value === 'object' && 'raw' in (value as object)) {
      facts[field] = { texts: [String((value as { raw?: string }).raw ?? '')] };
    }
  }
  for (const [field, value] of Object.entries(workPackage._links ?? {})) {
    if (!/^customField\d+$/.test(field) || !value) continue;
    const texts = (Array.isArray(value) ? value : [value]).map((link) => link.title ?? '').filter(Boolean);
    if (texts.length > 0) facts[field] = { texts };
  }
  return facts;
}
