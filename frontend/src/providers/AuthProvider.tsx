import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { NexusUser, Permission } from '@/types';
import { useCurrentUser } from '@/hooks/useUsers';

/**
 * Session state for the prototype.
 *
 * No credentials are ever stored client-side. A real deployment replaces this
 * with the Nexus backend session (an HTTP-only cookie) and an SSO redirect; the
 * only thing kept here is a non-sensitive "a session exists" marker so a page
 * refresh does not bounce the user back to the login screen.
 */

const SESSION_FLAG = 'nexus.session';

interface AuthContextValue {
  user: NexusUser | undefined;
  isAuthenticated: boolean;
  isLoading: boolean;
  permissions: Permission[];
  can: (permission: Permission) => boolean;
  signIn: () => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readSessionFlag(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_FLAG) === 'active';
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [hasSession, setHasSession] = useState(readSessionFlag);
  const queryClient = useQueryClient();
  const { data: user, isLoading } = useCurrentUser();

  const signIn = useCallback(() => {
    try {
      window.sessionStorage.setItem(SESSION_FLAG, 'active');
    } catch {
      /* storage unavailable — the session lasts until navigation */
    }
    setHasSession(true);
  }, []);

  const signOut = useCallback(() => {
    try {
      window.sessionStorage.removeItem(SESSION_FLAG);
    } catch {
      /* nothing to clear */
    }
    setHasSession(false);
    queryClient.clear();
  }, [queryClient]);

  // The demo user is a project manager: full delivery rights, no admin.
  const permissions = useMemo<Permission[]>(() => ['view', 'create', 'edit', 'delete'], []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: hasSession,
      isLoading: hasSession && isLoading,
      permissions,
      can: (permission) => permissions.includes(permission),
      signIn,
      signOut,
    }),
    [user, hasSession, isLoading, permissions, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
