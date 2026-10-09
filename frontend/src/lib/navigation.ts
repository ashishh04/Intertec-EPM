/**
 * Where to send someone after the router has had to detour them.
 *
 * `from` arrives as router state, which anything can set, so it is validated
 * rather than trusted: only a same-site absolute path is honoured, and never
 * /login itself, which would loop. Anything else falls back to the dashboard.
 */
export const DEFAULT_DESTINATION = '/dashboard';

/**
 * A path inside this app, and nothing that only looks like one.
 *
 * "//host/x" is a link to another site that merely starts with a slash, and a
 * backslash is read as a slash in a URL, so "/\host" is the same thing by
 * another name. Both are refused; so is anything with a scheme.
 */
export function isAppPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

export function safeDestination(from: unknown): string {
  if (typeof from !== 'string' || !isAppPath(from)) return DEFAULT_DESTINATION;
  if (from === '/login' || from.startsWith('/login?') || from.startsWith('/login#')) return DEFAULT_DESTINATION;
  return from;
}
