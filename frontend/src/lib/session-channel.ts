/**
 * Tabs of the app in one browser share a session, so they share what happens
 * to it: activity in any of them keeps all of them signed in, and signing out
 * in one signs out the rest — no tab is left showing a session that has ended.
 */

export type SessionEndReason = 'idle' | 'expired';

export type SessionMessage =
  | { type: 'activity'; at: number }
  | { type: 'signed-out'; reason?: SessionEndReason };

const channel: BroadcastChannel | null =
  typeof window !== 'undefined' && 'BroadcastChannel' in window ? new BroadcastChannel('epm.session') : null;

/** Tells the app's other tabs; this one does not hear itself. */
export function tellTabs(message: SessionMessage): void {
  try {
    channel?.postMessage(message);
  } catch {
    /* a closed channel: the other tabs find out on their next request */
  }
}

/** Listens to the app's other tabs. Returns the way to stop. */
export function hearTabs(listener: (message: SessionMessage) => void): () => void {
  if (!channel) return () => undefined;
  const onMessage = (event: MessageEvent<SessionMessage>) => listener(event.data);
  channel.addEventListener('message', onMessage);
  return () => channel.removeEventListener('message', onMessage);
}
