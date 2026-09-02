import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ChevronsLeft, ChevronsRight, Sparkles } from 'lucide-react';
import { NAV_SECTIONS, type NavItem } from '@/config/navigation';
import { featureFlags } from '@/config/env';
import { cn } from '@/lib/utils';
import { useUI } from '@/providers/UIProvider';
import { useAuth } from '@/providers/AuthProvider';
import { useUnreadCount } from '@/hooks/useNotifications';
import { EpmLogo, EpmMark } from '@/components/common/EpmLogo';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

const EXPANDED_WIDTH = 260;
const COLLAPSED_WIDTH = 72;

interface SidebarProps {
  /** Mobile renders the same navigation inside a slide-out sheet. */
  variant?: 'fixed' | 'sheet';
  onNavigate?: () => void;
}

/**
 * Primary navigation rail. Collapses to an icon rail and remembers that choice
 * across sessions.
 */
export function Sidebar({ variant = 'fixed', onNavigate }: SidebarProps) {
  const { sidebarCollapsed, toggleSidebar } = useUI();
  const { user } = useAuth();
  const unread = useUnreadCount();
  const location = useLocation();

  const collapsed = variant === 'sheet' ? false : sidebarCollapsed;

  const isActive = (item: NavItem) =>
    item.matchNested
      ? location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)
      : location.pathname === item.to;

  return (
    <motion.aside
      animate={{ width: variant === 'sheet' ? '100%' : collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
      initial={false}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      className={cn(
        'flex h-full flex-col border-r border-sidebar-border bg-sidebar',
        variant === 'fixed' && 'shrink-0',
      )}
    >
      {/* Brand */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center border-b border-sidebar-border',
          collapsed ? 'justify-center px-2' : 'px-4',
        )}
      >
        {collapsed ? (
          <EpmMark className="h-8 w-8" />
        ) : (
          <EpmLogo variant="full" className="min-w-0" />
        )}
      </div>

      {/* Navigation */}
      <nav
        aria-label="Primary"
        className={cn('epm-scroll flex-1 overflow-y-auto py-3', collapsed ? 'px-2' : 'px-3')}
      >
        {NAV_SECTIONS.map((section, sectionIndex) => (
          <div key={section.title ?? `section-${sectionIndex}`} className={cn(sectionIndex > 0 && 'mt-4')}>
            {section.title && !collapsed ? (
              <p className="epm-eyebrow px-2.5 pb-1.5">{section.title}</p>
            ) : null}
            {section.title && collapsed ? (
              <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border" aria-hidden />
            ) : null}

            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = isActive(item);
                const badgeCount = item.badge === 'notifications' ? unread : 0;

                const link = (
                  <NavLink
                    to={item.to}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex items-center gap-2.5 rounded-lg text-xs font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar',
                      collapsed ? 'h-9 w-9 justify-center' : 'px-2.5 py-2',
                      active
                        ? 'bg-sidebar-active text-primary'
                        : 'text-sidebar-muted hover:bg-muted hover:text-sidebar-foreground',
                    )}
                  >
                    {active ? (
                      <motion.span
                        layoutId="sidebar-active-indicator"
                        className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary"
                        transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                        aria-hidden
                      />
                    ) : null}
                    <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                    {!collapsed ? <span className="truncate">{item.label}</span> : null}
                    {badgeCount > 0 ? (
                      collapsed ? (
                        <span
                          className="absolute right-1 top-1 h-2 w-2 rounded-full bg-danger ring-2 ring-sidebar"
                          aria-hidden
                        />
                      ) : (
                        <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-danger-foreground">
                          {badgeCount > 9 ? '9+' : badgeCount}
                        </span>
                      )
                    ) : null}
                    {collapsed ? <span className="sr-only">{item.label}</span> : null}
                  </NavLink>
                );

                return (
                  <li key={item.to}>
                    {collapsed ? (
                      <Tooltip>
                        <TooltipTrigger asChild>{link}</TooltipTrigger>
                        <TooltipContent side="right">
                          {item.label}
                          {badgeCount > 0 ? ` · ${badgeCount} unread` : ''}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {featureFlags.epmAi ? (
          <div className={cn('mt-4', collapsed ? '' : 'px-0.5')}>
            <button
              type="button"
              onClick={() =>
                toast('EPM AI is not available yet', {
                  description: 'The assistant entry point is reserved for a future release.',
                })
              }
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg border border-dashed border-highlight/40 text-xs font-medium text-highlight transition-colors hover:bg-highlight-soft',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                collapsed ? 'h-9 w-9 justify-center' : 'px-2.5 py-2',
              )}
            >
              <Sparkles className="h-4 w-4 shrink-0" aria-hidden />
              {!collapsed ? <span>Ask EPM</span> : <span className="sr-only">Ask EPM</span>}
            </button>
          </div>
        ) : null}
      </nav>

      {/* User + collapse control */}
      <div className={cn('shrink-0 border-t border-sidebar-border', collapsed ? 'p-2' : 'p-3')}>
        <div
          className={cn(
            'flex items-center gap-2.5 rounded-lg',
            collapsed ? 'justify-center' : 'px-1 py-1',
          )}
        >
          <UserAvatar user={user} size={collapsed ? 'default' : 'default'} showStatus />
          {!collapsed ? (
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-sidebar-foreground">
                {user?.name ?? 'Loading…'}
              </p>
              <p className="truncate text-2xs text-sidebar-muted">{user?.role ?? ''}</p>
            </div>
          ) : null}
        </div>

        {variant === 'fixed' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!sidebarCollapsed}
            className={cn('mt-2 w-full text-2xs', collapsed && 'justify-center px-0')}
          >
            {sidebarCollapsed ? (
              <ChevronsRight className="h-3.5 w-3.5" />
            ) : (
              <>
                <ChevronsLeft className="h-3.5 w-3.5" />
                Collapse
              </>
            )}
          </Button>
        ) : null}
      </div>
    </motion.aside>
  );
}
