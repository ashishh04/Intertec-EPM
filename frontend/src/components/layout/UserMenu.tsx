import { useNavigate } from 'react-router-dom';
import { LogOut, Settings, ShieldCheck, User } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useAuth } from '@/providers/AuthProvider';
import { isAdministrator, roleLabel } from '@/config/navigation';
import { t } from '@/lib/i18n';

/** Avatar button in the header: identity and sign-out. */
export function UserMenu() {
  const { user, signOut, can, role } = useAuth();
  const administrator = isAdministrator(can);
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="rounded-full transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={t('Open account menu')}
      >
        <UserAvatar user={user} size="default" showStatus />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <UserAvatar user={user} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{user?.name ?? t('Signed in')}</p>
            <p className="truncate text-2xs text-muted-foreground">{roleLabel(role)}</p>
            <p className="truncate font-mono text-2xs text-muted-foreground/80">{user?.email}</p>
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => navigate('/profile')}>
          <User />
          {t('Profile')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings />
          {t('Settings')}
        </DropdownMenuItem>
        {administrator ? (
          <DropdownMenuItem onSelect={() => navigate('/admin')}>
            <ShieldCheck />
            {t('Administration')}
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          // `signOut` redirects with a full page load, deliberately: it is the
          // only way to guarantee no in-memory state survives the session. A
          // client-side navigate() here as well only raced it to /login.
          onSelect={() => signOut()}
        >
          <LogOut />
          {t('Sign out')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
