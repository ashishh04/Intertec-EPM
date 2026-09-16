import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/services/api/client';
import type { EpmUser, ID, Permission, PermissionMap } from '@/types';
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
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => void;
  /** Sets the caller's own password and clears the gate. */
  changePassword: (password: string) => Promise<void>;
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
      await apiClient.post<SessionResponse>('/auth/login', { username, password });
      await queryClient.invalidateQueries({ queryKey: ['auth', 'session'] });
    },
    [queryClient],
  );

  const changePassword = useCallback(
    async (password: string) => {
      await apiClient.post('/me/password', { password });
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
        window.location.assign('/login');
      });
  }, [queryClient]);

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

      signIn,
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
