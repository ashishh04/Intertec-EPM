import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { MoreHorizontal, Plus } from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sidebar } from './Sidebar';
import { MOBILE_NAV_ITEMS, NAV_SECTIONS } from '@/config/navigation';
import { useUI } from '@/providers/UIProvider';
import { useUnreadCount } from '@/hooks/useNotifications';
import { cn } from '@/lib/utils';

/** Slide-out full navigation, opened from the header menu button on small screens. */
export function MobileNavSheet() {
  const { mobileNavOpen, setMobileNavOpen } = useUI();

  return (
    <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
      <SheetContent side="left" className="w-[17rem] p-0 sm:max-w-[17rem]" hideClose>
        <Sidebar variant="sheet" onNavigate={() => setMobileNavOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

/**
 * Bottom navigation for phones. Every target is at least 44px tall, and the
 * create action sits in the centre where it is easiest to reach.
 */
export function MobileBottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const unread = useUnreadCount();
  const { openTaskDrawer, setMobileNavOpen } = useUI();

  const isActive = (to: string, matchNested?: boolean) =>
    matchNested ? location.pathname.startsWith(to) : location.pathname === to;

  const [first, second, third, fourth] = MOBILE_NAV_ITEMS;

  const renderItem = (item: (typeof MOBILE_NAV_ITEMS)[number]) => {
    const active = isActive(item.to, item.matchNested);
    const badgeCount = item.badge === 'notifications' ? unread : 0;

    return (
      <NavLink
        key={item.to}
        to={item.to}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        <span className="relative">
          <item.icon className="h-5 w-5" aria-hidden />
          {badgeCount > 0 ? (
            <span
              className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-danger ring-2 ring-surface"
              aria-hidden
            />
          ) : null}
        </span>
        {item.label}
      </NavLink>
    );
  };

  return (
    <nav
      aria-label="Primary mobile"
      className="fixed inset-x-0 bottom-0 z-30 flex items-stretch gap-1 border-t border-border bg-surface/95 px-2 pb-[env(safe-area-inset-bottom)] pt-1 backdrop-blur-md md:hidden"
    >
      {renderItem(first)}
      {renderItem(second)}

      <button
        type="button"
        onClick={() => openTaskDrawer()}
        aria-label="Create task"
        className="mx-1 my-1 flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-full bg-primary text-primary-foreground shadow-elevated transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Plus className="h-5 w-5" />
      </button>

      {renderItem(third)}
      {renderItem(fourth)}

      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="More navigation"
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden />
          More
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="mb-1 max-h-80 w-52 overflow-y-auto">
          <DropdownMenuItem onSelect={() => setMobileNavOpen(true)}>
            Browse all sections
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {NAV_SECTIONS.slice(2).map((section) => (
            <div key={section.title}>
              <DropdownMenuLabel>{section.title}</DropdownMenuLabel>
              {section.items.map((item) => (
                <DropdownMenuItem key={item.to} onSelect={() => navigate(item.to)}>
                  <item.icon />
                  {item.label}
                </DropdownMenuItem>
              ))}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
