import { createContext, useCallback, useContext, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/services/api/client';
import type { EpmUser, Permission } from '@/types';
import { useCurrentUser } from '@/hooks/useUsers';

/**
 * Session state.
 *
 * Credentials are posted to the EPM backend, which verifies them upstream and
 * keeps the resulting tokens server-side behind an HTTP-only cookie. The
 * browser never holds a credential, and every request travels on the signed-in
 * user's own token, so their real permissions apply.
 */

interface SessionResponse {
  userId: string;
  authenticated: boolean;
}

interface AuthContextValue {
  user: EpmUser | undefined;
  isAuthenticated: boolean;
  isLoading: boolean;
  permissions: Permission[];
  can: (permission: Permission) => boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

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

  const signIn = useCallback(
    async (username: string, password: string) => {
      await apiClient.post<SessionResponse>('/auth/login', { username, password });
      // The session cookie is set; re-read rather than assuming success shape.
      await queryClient.invalidateQueries({ queryKey: ['auth', 'session'] });
    },
    [queryClient],
  );

  const signOut = useCallback(() => {
    void apiClient
      .post('/auth/logout')
      .catch(() => undefined)
      .finally(() => {
        queryClient.clear();
        window.location.assign('/login');
      });
  }, [queryClient]);

  // TODO: source from the backend. Hardcoded to full delivery rights until
  // /api/me carries the caller's OpenProject permissions.
  const permissions = useMemo<Permission[]>(() => ['view', 'create', 'edit', 'delete'], []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: hasSession,
      isLoading: sessionQuery.isLoading || (hasSession && isUserLoading),
      permissions,
      can: (permission) => permissions.includes(permission),
      signIn,
      signOut,
    }),
    [user, hasSession, sessionQuery.isLoading, isUserLoading, permissions, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider.');
  return context;
}
