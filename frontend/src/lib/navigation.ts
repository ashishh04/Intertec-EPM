/**
 * Where to send someone after the router has had to detour them.
 *
 * `from` arrives as router state, which anything can set, so it is validated
 * rather than trusted: only a same-site absolute path is honoured, and never
 * /login itself, which would loop. Anything else falls back to the dashboard.
 */
export const DEFAULT_DESTINATION = '/dashboard';

export function safeDestination(from: unknown): string {
  if (typeof from !== 'string') return DEFAULT_DESTINATION;
  if (!from.startsWith('/') || from.startsWith('//')) return DEFAULT_DESTINATION;
  if (from === '/login') return DEFAULT_DESTINATION;
  return from;
}
