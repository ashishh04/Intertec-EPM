import { useNavigate } from 'react-router-dom';
import { Check, LogOut, Monitor, Moon, Settings, Sun, User } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useAuth } from '@/providers/AuthProvider';
import { useTheme, type ThemeSetting } from '@/providers/ThemeProvider';
import { cn } from '@/lib/utils';

const THEME_OPTIONS: { value: ThemeSetting; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Avatar button in the header: identity, theme control and sign-out. */
export function UserMenu() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="rounded-full transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label="Open account menu"
      >
        <UserAvatar user={user} size="default" showStatus />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <UserAvatar user={user} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{user?.name ?? 'Signed in'}</p>
            <p className="truncate text-2xs text-muted-foreground">{user?.role}</p>
            <p className="truncate font-mono text-2xs text-muted-foreground/80">{user?.email}</p>
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => navigate('/profile')}>
          <User />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings />
          Settings
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        {THEME_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={(event) => {
              event.preventDefault();
              setTheme(option.value);
            }}
          >
            <option.icon />
            {option.label}
            <Check
              className={cn('ml-auto h-3.5 w-3.5', theme === option.value ? 'opacity-100' : 'opacity-0')}
              aria-hidden
            />
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          // `signOut` redirects with a full page load, deliberately: it is the
          // only way to guarantee no in-memory state survives the session. A
          // client-side navigate() here as well only raced it to /login.
          onSelect={() => signOut()}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
