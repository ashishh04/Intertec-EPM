import type { ServerResponse } from 'node:http';

/**
 * Live updates: what changed, said to every open page, so screens follow a
 * change made anywhere — by another person, in another tab, by a background
 * job — without anyone reloading or clicking.
 *
 * Only areas are said ("work", "time", "sprints", …), never what changed in
 * them. A page that hears one reloads what it shows from that area through the
 * same authorised reads as ever, so the stream carries nothing anyone could not
 * already read. What only one person should hear — their notifications, their
 * own preferences — goes to their pages alone.
 *
 * Changes come in bursts (a save writes several records, an import hundreds),
 * so they are gathered for half a second and said once.
 */

interface Listener {
  userId: string;
  sessionId: string;
  stream: ServerResponse;
}

const listeners = new Map<number, Listener>();
let nextListener = 1;

/** Areas waiting to be said: to everyone, and to one person. */
const shared = new Set<string>();
const personal = new Map<string, Set<string>>();
let gathering: NodeJS.Timeout | undefined;
const GATHER_MS = 500;

/** Says that something in these areas changed — to everyone, or with `userId` to that person alone. */
export function announce(areas: string | readonly string[], options: { userId?: string } = {}): void {
  const list = (typeof areas === 'string' ? [areas] : areas).filter(Boolean);
  if (list.length === 0 || listeners.size === 0) return;
  if (options.userId) {
    const own = personal.get(options.userId) ?? new Set<string>();
    for (const area of list) own.add(area);
    personal.set(options.userId, own);
  } else {
    for (const area of list) shared.add(area);
  }
  gathering ??= setTimeout(flush, GATHER_MS);
}

function flush(): void {
  gathering = undefined;
  const everyone = [...shared];
  shared.clear();
  const own = new Map(personal);
  personal.clear();
  for (const [id, listener] of listeners) {
    const areas = [...new Set([...everyone, ...(own.get(listener.userId) ?? [])])];
    if (areas.length === 0) continue;
    if (!write(listener.stream, `data: ${JSON.stringify({ areas })}\n\n`)) listeners.delete(id);
  }
}

/** Writes to a stream; false once it can no longer be written to. */
export function write(stream: ServerResponse, text: string): boolean {
  if (stream.destroyed || stream.writableEnded) return false;
  try {
    stream.write(text);
    return true;
  } catch {
    return false;
  }
}

/** Starts telling a page; the returned function stops. */
export function addListener(listener: Listener): () => void {
  const id = nextListener;
  nextListener += 1;
  listeners.set(id, listener);
  return () => {
    listeners.delete(id);
  };
}

/** Every page being told, for the heartbeat. */
export function everyListener(): ReadonlyMap<number, Listener> {
  return listeners;
}

export function dropListener(id: number): void {
  const listener = listeners.get(id);
  listeners.delete(id);
  if (listener && !listener.stream.writableEnded) listener.stream.end();
}

/**
 * The area a write to OpenProject changes, by its path (`/api/v3/work_packages/12`).
 * What EPM keeps itself is said where it is written (app.ts, the stores).
 */
export function areaOfUpstream(path: string): string | undefined {
  const resource = /\/api\/v3\/([a-z_]+)/.exec(path)?.[1];
  switch (resource) {
    case 'work_packages':
    case 'relations':
    case 'attachments':
    case 'activities':
    case 'watchers':
    case 'file_links':
      return 'work';
    case 'time_entries':
      return 'time';
    case 'versions':
      return 'sprints';
    case 'memberships':
      return 'members';
    case 'projects':
      return 'projects';
    case 'queries':
      return 'views';
    case 'users':
    case 'groups':
    case 'principals':
    case 'placeholder_users':
      return 'people';
    default:
      return undefined;
  }
}

/** Routes that write nothing anyone else sees, or nothing at all. */
const UNSAID = new Set(['auth', 'assistant', 'sessions', 'feeds', 'password-reset', 'invites', 'analytics', 'search']);
/** Routes whose writes are one person's own: said to their pages only. */
const OWN: Record<string, string> = { notifications: 'notifications', preferences: 'preferences', me: 'me' };
/** Routes named otherwise than the area they change. */
const ROUTE_AREA: Record<string, string> = {
  'time-entries': 'time',
  timesheets: 'time',
  tasks: 'work',
  'work-packages': 'work',
  boards: 'work',
  backlog: 'work',
  schedule: 'work',
  risks: 'work',
  impediments: 'work',
  'stage-gates': 'work',
  'task-series': 'work',
  'task-imports': 'work',
  sprints: 'sprints',
  queries: 'views',
  accounts: 'people',
  employees: 'people',
  users: 'people',
  teams: 'people',
  departments: 'people',
  'placeholder-users': 'people',
};
/** POSTs that only show what would happen. */
const DRY_RUN = /\/(dry-run|preview|backtest|forms?)(\/|$)/;

/**
 * The area a successful write through EPM's API changes, by its route
 * (`/api/meetings/4/agenda` → meetings), and whether it is one person's own.
 */
export function areaOfRequest(method: string, url: string, apiPrefix: string): { area: string; own: boolean } | undefined {
  const path = (url.split('?')[0] ?? '').slice(apiPrefix.length);
  if (method === 'POST' && DRY_RUN.test(path)) return undefined;
  const segment = /^\/([a-z0-9-]+)/.exec(path)?.[1];
  if (!segment || UNSAID.has(segment)) return undefined;
  if (OWN[segment]) return { area: OWN[segment]!, own: true };
  return { area: ROUTE_AREA[segment] ?? segment, own: false };
}
