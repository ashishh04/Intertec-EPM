import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiClient, ApiError } from '@/services/api/client';
import { useAuth, type SessionClock } from '@/providers/AuthProvider';
import { hearTabs, tellTabs, type SessionEndReason } from '@/lib/session-channel';
import { t } from '@/lib/i18n';

/** The person's activity reaches the server at most this often. */
const REPORT_EVERY_MS = 60_000;
/** And the app's other tabs at most this often. */
const SHARE_EVERY_MS = 5_000;
/** Before reminding or signing out, the server is asked at most this often. */
const CHECK_EVERY_MS = 30_000;
/** Ahead of the longest a session lasts, a notice this far before. */
const END_NOTICE_MS = 5 * 60_000;
/**
 * The page signs out this much before the server would. The server's clock
 * starts a moment before the page hears back, so at the very end a background
 * read could reach the server first and be refused; signing out a little early
 * keeps the tidy way out — every tab told, the page to return to kept — the one taken.
 */
const AHEAD_MS = 5_000;
/** What counts as the person being there. Scrolls are heard on the document, where every one arrives. */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;

const reasonOf = (error: unknown): SessionEndReason =>
  error instanceof ApiError && error.code === 'SESSION_EXPIRED' ? 'expired' : 'idle';

/**
 * Signs a person out after a stretch without activity (30 minutes unless
 * configured otherwise), with a reminder half-way (15) to stay signed in or
 * sign out — and at the longest a session may last (12 hours), with a notice
 * shortly before.
 *
 * The server enforces both whatever this page does (auth/oauth.ts): this is
 * the warning and the tidy way out. Activity is a click, a key, scrolling or
 * moving the mouse in any of the app's tabs; the page refreshing itself is not.
 * It is reported to the server at most once a minute, and shared with the
 * other tabs, so a tab left in the background does not sign out someone busy in
 * another. Times are counted from timestamps, not ticks, so a tab the browser
 * slowed down, or a laptop that slept, still signs out on time when it wakes.
 */
export function SessionTimeout() {
  const { session, signOut } = useAuth();

  /** The server's clock less this computer's. */
  const offset = useRef(0);
  const lastActivity = useRef(Date.now());
  const lastReport = useRef(0);
  const lastShare = useRef(0);
  const lastCheck = useRef(0);
  const endsAt = useRef<number | undefined>(undefined);
  const reminding = useRef(false);
  const leaving = useRef(false);
  const noticed = useRef(false);
  const [warning, setWarning] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [staying, setStaying] = useState(false);

  const idleMs = Math.max(0, (session?.idleMinutes ?? 0) * 60_000 - AHEAD_MS);
  const warnMs = (session?.warnAfterMinutes ?? 0) * 60_000;
  const hasClock = Boolean(session);

  /** The server's clock, taken in: its last activity may be newer (another tab), and its end is fixed. */
  const takeClock = useCallback((clock: SessionClock | undefined) => {
    if (!clock) return;
    offset.current = Date.parse(clock.serverNow) - Date.now();
    const lastActive = Date.parse(clock.lastActiveAt) - offset.current;
    if (lastActive > lastActivity.current) lastActivity.current = lastActive;
    endsAt.current = Date.parse(clock.endsAt) - offset.current;
  }, []);

  useEffect(() => takeClock(session), [session, takeClock]);

  const leave = useCallback(
    (reason: SessionEndReason) => {
      if (leaving.current) return;
      leaving.current = true;
      signOut(reason);
    },
    [signOut],
  );

  const setReminding = (next: boolean) => {
    if (reminding.current === next) return;
    reminding.current = next;
    setWarning(next);
  };

  /** Tells the server the person is here. False when it could not be told. */
  const report = useCallback(async (): Promise<boolean> => {
    lastReport.current = Date.now();
    try {
      const answer = await apiClient.post<{ session?: SessionClock }>('/auth/activity');
      takeClock(answer.session);
      return true;
    } catch (error) {
      // The server has ended it already: out, saying why.
      if (error instanceof ApiError && error.status === 401) leave(reasonOf(error));
      return false;
    }
  }, [leave, takeClock]);

  // Opening the app is the person being here.
  useEffect(() => {
    if (hasClock) void report();
  }, [hasClock, report]);

  // Activity: here, and in the app's other tabs.
  useEffect(() => {
    if (!hasClock) return undefined;
    const onActivity = () => {
      // While the reminder is up only its buttons count: a mouse brushed in
      // passing is not someone choosing to stay.
      if (reminding.current || leaving.current) return;
      const at = Date.now();
      lastActivity.current = at;
      if (at - lastShare.current >= SHARE_EVERY_MS) {
        lastShare.current = at;
        tellTabs({ type: 'activity', at });
      }
      if (at - lastReport.current >= REPORT_EVERY_MS) void report();
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { capture: true, passive: true });
    document.addEventListener('scroll', onActivity, { capture: true, passive: true });
    const stop = hearTabs((message) => {
      if (message.type !== 'activity') return;
      // The person is busy in another tab: this one's reminder goes too.
      if (message.at > lastActivity.current) lastActivity.current = message.at;
      setReminding(false);
    });
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity, { capture: true });
      document.removeEventListener('scroll', onActivity, { capture: true });
      stop();
    };
  }, [hasClock, report]);

  // The clock: the reminder, the end for want of activity, and the longest a session lasts.
  useEffect(() => {
    if (!hasClock || idleMs <= 0) return undefined;
    let checking = false;

    /** The server's view, before reminding or signing out: a tab this one cannot hear may have kept it going. */
    const check = async () => {
      lastCheck.current = Date.now();
      try {
        const answer = await apiClient.get<{ session?: SessionClock }>('/auth/session');
        takeClock(answer.session);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) leave(reasonOf(error));
      }
    };

    const tick = async () => {
      if (leaving.current || checking) return;
      const at = Date.now();
      if (endsAt.current !== undefined) {
        if (at >= endsAt.current - AHEAD_MS) {
          leave('expired');
          return;
        }
        if (!noticed.current && endsAt.current - at <= END_NOTICE_MS) {
          noticed.current = true;
          toast.warning(
            t('Your session ends in {minutes, plural, one {# minute} other {# minutes}}', {
              minutes: Math.max(1, Math.ceil((endsAt.current - at) / 60_000)),
            }),
            { description: t('Save your work: you will need to sign in again then.'), duration: 30_000 },
          );
        }
      }
      if (at - lastActivity.current >= warnMs && Date.now() - lastCheck.current >= CHECK_EVERY_MS) {
        checking = true;
        await check();
        checking = false;
        if (leaving.current) return;
      }
      const idle = Date.now() - lastActivity.current;
      if (idle >= idleMs) {
        leave('idle');
        return;
      }
      const remind = idle >= warnMs;
      setReminding(remind);
      if (remind) setNow(Date.now());
    };

    const timer = window.setInterval(() => void tick(), 1_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [hasClock, idleMs, warnMs, leave, takeClock]);

  const stay = async () => {
    setStaying(true);
    const reached = await report();
    setStaying(false);
    if (!reached || leaving.current) return;
    const at = Date.now();
    lastActivity.current = at;
    tellTabs({ type: 'activity', at });
    setReminding(false);
  };

  if (!session) return null;

  const idleFor = Math.max(0, now - lastActivity.current);
  const remaining = Math.max(0, idleMs - idleFor);
  const countdown = `${Math.floor(remaining / 60_000)}:${String(Math.floor((remaining % 60_000) / 1_000)).padStart(2, '0')}`;

  return (
    <Dialog open={warning} onOpenChange={() => undefined}>
      <DialogContent
        hideClose
        role="alertdialog"
        className="sm:max-w-md"
        // A choice is asked for: neither Escape nor a click beside it makes one.
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        data-testid="session-timeout"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-warning" aria-hidden />
            {t('Are you still there?')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'There has been no activity for {minutes, plural, one {# minute} other {# minutes}}. For your security you will be signed out in {time} unless you stay signed in.',
              { minutes: Math.floor(idleFor / 60_000), time: countdown },
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="py-2 text-center font-mono text-3xl tabular-nums text-foreground" aria-hidden>
          {countdown}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => signOut()} disabled={staying}>
            {t('Sign out')}
          </Button>
          <Button onClick={() => void stay()} loading={staying} autoFocus>
            {t('Stay signed in')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
