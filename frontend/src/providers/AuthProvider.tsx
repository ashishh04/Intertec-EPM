import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/services/api/client';
import type { AppRole, EpmUser, ID, Permission, PermissionMap } from '@/types';
import { useCurrentUser } from '@/hooks/useUsers';
import { purgeStoredResponses } from '@/lib/response-cache';
import { hearTabs, tellTabs, type SessionEndReason } from '@/lib/session-channel';

/**
 * Session and authorisation state.
 *
 * Credentials are posted to the EPM backend, which verifies them upstream and
 * keeps the resulting tokens server-side behind an HTTP-only cookie. The
 * browser never holds a credential, and every request travels on the signed-in
 * user's own token, so their real permissions apply.
 *
 * Permissions come from the backend, which derives them from the user's actual
 * capabilities. They exist to decide what the UI offers. They are not a
 * security boundary — the backend authorises every mutation independently, and
 * a client that lies about them gains nothing.
 */

/**
 * Where the session stands (auth/oauth.ts `sessionClock`): it ends after
 * `idleMinutes` without activity, with a reminder `warnAfterMinutes` into the
 * quiet, and at `endsAt` whatever happens. Times are the server's; `serverNow`
 * lets the page correct for its own clock.
 */
export interface SessionClock {
  idleMinutes: number;
  warnAfterMinutes: number;
  maxHours: number;
  lastActiveAt: string;
  idleEndsAt: string;
  endsAt: string;
  serverNow: string;
}

interface SessionResponse {
  userId: string;
  authenticated: boolean;
  /** Absent from an older server, which has no idle limit. */
  session?: SessionClock;
}

interface MeResponse extends EpmUser {
  permissions?: PermissionMap;
  projectPermissions?: Record<string, PermissionMap>;
  mustChangePassword?: boolean;
  mfaSetupRequired?: boolean;
  appRole?: AppRole;
}

export interface SecondFactorResult {
  via: 'totp' | 'recovery';
  recoveryCodesLeft: number;
}

interface AuthContextValue {
  user: EpmUser | undefined;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Global permissions — those that hold regardless of project. */
  can: (permission: Permission) => boolean;
  /**
   * Whether a permission holds inside a project. A user may manage one project
   * and only read another, so project-scoped actions must ask with the project.
   */
  canInProject: (projectId: ID | undefined, permission: Permission) => boolean;
  /**
   * Whether a permission holds anywhere. Only for deciding if an entry point is
   * worth showing at all — never for enabling an action on a specific record.
   */
  canAnywhere: (permission: Permission) => boolean;
  /**
   * Whether this person still has the password an administrator handed them.
   *
   * Held at the door until they replace it: the starting password is a handover
   * credential, not theirs. The upstream API has no way to require this — it
   * accepts the field and ignores it — so EPM enforces it around its own
   * session.
   */
  mustChangePassword: boolean;
  /** A client or vendor: they see only the portal (BR-611). */
  external: boolean;
  /**
   * Admin, Manager, HR or Employee: which sidebar and screens this person gets.
   * Like the permissions, a courtesy for the UI — the backend applies the
   * role's permissions itself.
   */
  role: AppRole;
  /**
   * Their role requires two-factor authentication and they have not set it up:
   * held at the set-up screen. The server holds them too (auth/hook.ts).
   */
  mfaSetupRequired: boolean;
  /** `mfaRequired` means the password was right and a code is still owed: nobody is signed in yet. */
  signIn: (username: string, password: string) => Promise<{ mfaRequired: boolean }>;
  /** The second half of signing in: a code from their app, or a recovery code. */
  verifySecondFactor: (code: string) => Promise<SecondFactorResult>;
  /** Gives up a sign-in that is waiting for its code. */
  cancelSecondFactor: () => Promise<void>;
  /**
   * Signs out here and in the app's other tabs. With a reason when the session
   * ended on its own — no activity, or the longest it may last — which the
   * sign-in page then explains.
   */
  signOut: (reason?: SessionEndReason) => void;
  /** The session's clock, for the reminder before it ends for want of activity. */
  session: SessionClock | undefined;
  /** The server has just ended the session this browser held, and why. */
  ended: SessionEndReason | undefined;
  /** Sets the caller's own password and clears the gate. */
  /** The current password as well as the new one: a session alone does not change a password. */
  changePassword: (currentPassword: string, password: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Why the server refused the session, when it ended it: no activity, or the longest a session lasts. */
function endedBy(error: unknown): SessionEndReason | undefined {
  const code = (error as { code?: string } | null)?.code;
  return code === 'SESSION_IDLE' ? 'idle' : code === 'SESSION_EXPIRED' ? 'expired' : undefined;
}

function lookup(map: PermissionMap | undefined, permission: Permission): boolean {
  const [group, action] = permission.split(':');
  if (!group || !action) return false;
  return map?.[group]?.[action] === true;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const sessionQuery = useQuery({
    queryKey: ['auth', 'session'],
    queryFn: () => apiClient.get<SessionResponse>('/auth/session'),
    // A 401 here is the normal signed-out answer, not a fault to retry.
    retry: false,
    staleTime: 60_000,
  });

  const hasSession = sessionQuery.data?.authenticated === true;

  // Only ask who the user is once a session exists, or the request 401s and
  // the error surfaces as a broken page behind the login screen.
  const { data: user, isLoading: isUserLoading } = useCurrentUser({ enabled: hasSession });

  const me = user as MeResponse | undefined;

  const signIn = useCallback(
    async (username: string, password: string) => {
      const answer = await apiClient.post<SessionResponse & { mfaRequired?: boolean }>('/auth/login', { username, password });
      if (answer.mfaRequired) return { mfaRequired: true };
      await queryClient.invalidateQueries({ queryKey: ['auth', 'session'] });
      return { mfaRequired: false };
    },
    [queryClient],
  );

  const verifySecondFactor = useCallback(
    async (code: string) => {
      const answer = await apiClient.post<SessionResponse & SecondFactorResult>('/auth/mfa/verify', { code });
      await queryClient.invalidateQueries({ queryKey: ['auth', 'session'] });
      return { via: answer.via, recoveryCodesLeft: answer.recoveryCodesLeft };
    },
    [queryClient],
  );

  const cancelSecondFactor = useCallback(async () => {
    await apiClient.post('/auth/mfa/cancel').catch(() => undefined);
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, password: string) => {
      await apiClient.post('/me/password', { password, currentPassword });
      // Refetched rather than assumed: the gate is cleared by the backend, and
      // reading it back is what proves the change actually landed.
      await queryClient.invalidateQueries({ queryKey: ['current-user'] });
    },
    [queryClient],
  );

  /**
   * Leaves the signed-in app: everything it held goes — its answers in memory,
   * anything an earlier build stored, this tab's session storage — and the page
   * is replaced, not navigated, so Back after signing out cannot open it again.
   */
  const leave = useCallback(
    (reason?: SessionEndReason) => {
      queryClient.clear();
      purgeStoredResponses();
      try {
        window.sessionStorage.clear();
      } catch {
        /* storage unavailable: nothing kept there */
      }
      // Signed out by the clock rather than by choice: the sign-in page says
      // why, and signing in again returns to the page that was open.
      const here = `${window.location.pathname}${window.location.search}`;
      window.location.replace(reason ? `/login?reason=${reason}&from=${encodeURIComponent(here)}` : '/login');
    },
    [queryClient],
  );

  const signOut = useCallback(
    (reason?: SessionEndReason) => {
      // A button may hand its click event in: only the two reasons are reasons.
      const why = reason === 'idle' || reason === 'expired' ? reason : undefined;
      tellTabs({ type: 'signed-out', reason: why });
      // The server drops the session and tells the browser to clear its cache.
      void apiClient
        .post('/auth/logout')
        .catch(() => undefined)
        .finally(() => leave(why));
    },
    [leave],
  );

  // Signed out in another tab of the app: this one leaves too, without asking
  // the server again. Only while signed in here — a tab on the sign-in page
  // keeps what is being typed into it.
  const signedIn = useRef(false);
  signedIn.current = hasSession;
  useEffect(
    () =>
      hearTabs((message) => {
        if (message.type === 'signed-out' && signedIn.current) leave(message.reason);
      }),
    [leave],
  );

  /*
   * A page the browser restores from its back/forward cache comes back exactly
   * as it was left, data on screen, without asking the server anything. So it is
   * loaded afresh instead: the session is checked again, and a browser that has
   * signed out shows the sign-in page, never what was open before. (The app's
   * page is also served `no-store`, which keeps most browsers from caching it
   * that way at all; this covers the ones that still do.)
   */
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const global = me?.permissions;
    const byProject = me?.projectPermissions ?? {};

    return {
      user,
      isAuthenticated: hasSession,
      isLoading: sessionQuery.isLoading || (hasSession && isUserLoading),

      can: (permission) => lookup(global, permission),

      canInProject: (projectId, permission) =>
        projectId === undefined ? false : lookup(byProject[String(projectId)], permission),

      canAnywhere: (permission) =>
        lookup(global, permission) ||
        Object.values(byProject).some((map) => lookup(map, permission)),

      mustChangePassword: me?.mustChangePassword ?? false,
      mfaSetupRequired: me?.mfaSetupRequired ?? false,
      external: me?.external === true,
      // A backend older than roles sends none: its administrators stay administrators.
      role: me?.appRole ?? (lookup(global, 'users:manage') ? 'admin' : 'employee'),

      signIn,
      verifySecondFactor,
      cancelSecondFactor,
      signOut,
      session: sessionQuery.data?.session,
      ended: endedBy(sessionQuery.error),
      changePassword,
    };
  }, [
    user,
    me,
    hasSession,
    sessionQuery.isLoading,
    sessionQuery.data?.session,
    sessionQuery.error,
    isUserLoading,
    signIn,
    verifySecondFactor,
    cancelSecondFactor,
    signOut,
    changePassword,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider.');
  return context;
}
