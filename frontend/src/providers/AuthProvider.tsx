import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/services/api/client';
import type { AppRole, EpmUser, ID, Permission, PermissionMap } from '@/types';
import { useCurrentUser } from '@/hooks/useUsers';
import { clearPersistedCache, reconcilePersistedCacheOwner } from '@/lib/queryPersister';

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

interface SessionResponse {
  userId: string;
  authenticated: boolean;
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
  signOut: () => void;
  /** Sets the caller's own password and clears the gate. */
  /** The current password as well as the new one: a session alone does not change a password. */
  changePassword: (currentPassword: string, password: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

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

  const signOut = useCallback(() => {
    void apiClient
      .post('/auth/logout')
      .catch(() => undefined)
      .finally(() => {
        queryClient.clear();
        // `clear()` empties memory; this empties the copy on disk. Without it
        // the next person to open this browser would restore the previous
        // user's projects and tasks before their own session was checked.
        clearPersistedCache();
        // Replace, not assign: the page signed out from does not stay behind in
        // the history, so Back after signing out cannot open it again.
        window.location.replace('/login');
      });
  }, [queryClient]);

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

  /*
   * Sign-out clears the persisted cache, but a session can also end by expiry
   * or by the tab being closed — neither of which runs that path. So the cache
   * records who it belongs to, and the moment the signed-in user is known a
   * mismatch discards it and refetches.
   */
  useEffect(() => {
    if (!me?.id) return;
    if (reconcilePersistedCacheOwner(String(me.id))) {
      queryClient.clear();
    }
  }, [me?.id, queryClient]);

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
      changePassword,
    };
  }, [
    user,
    me,
    hasSession,
    sessionQuery.isLoading,
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
