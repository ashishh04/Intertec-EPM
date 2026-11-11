import { NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronsLeft, ChevronsRight, Sparkles } from 'lucide-react';
import { navItemActive, roleLabel, visibleNavSections, type NavItem } from '@/config/navigation';
import { featureFlags } from '@/config/env';
import { cn } from '@/lib/utils';
import { isRightToLeft, t } from '@/lib/i18n';
import { useUI } from '@/providers/UIProvider';
import { useAuth } from '@/providers/AuthProvider';
import { useApprovalInboxCount } from '@/hooks/useApprovals';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useUnreadCount } from '@/hooks/useNotifications';
import { EpmLogo, EpmMark } from '@/components/common/EpmLogo';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { CountBadge } from '@/components/ui/badge';

const EXPANDED_WIDTH = 272;
const COLLAPSED_WIDTH = 72;

interface SidebarProps {
  /** Mobile renders the same navigation inside a slide-out sheet. */
  variant?: 'fixed' | 'sheet';
  onNavigate?: () => void;
}

/**
 * Primary navigation rail. Collapses to an icon rail and remembers that choice
 * across sessions. Its links and headings are set dark, at 13px, to read at a
 * glance.
 */
export function Sidebar({ variant = 'fixed', onNavigate }: SidebarProps) {
  const { sidebarCollapsed, toggleSidebar, openPragnya } = useUI();
  const { user, can, role } = useAuth();
  const unread = useUnreadCount();
  const waiting = useApprovalInboxCount();
  const location = useLocation();
  // Filtered per person: administration items only appear for those who hold
  // the permission, and whole areas follow the person's role (Admin, Manager,
  // HR, Employee), so each of them sees a different rail.
  const sections = visibleNavSections(can, role);

  const collapsed = variant === 'sheet' ? false : sidebarCollapsed;
  // Groups someone has closed, by where each leads; every group starts open.
  const [closedGroups, setClosedGroups] = useLocalStorage<string[]>('epm.sidebar.closed-groups', []);

  const isActive = (item: NavItem) => navItemActive(item, location.pathname);

  const linkClass = (active: boolean, nested = false) =>
    cn(
      'group relative flex items-center gap-3 rounded-lg font-display text-[0.8125rem] font-medium transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar',
      collapsed ? 'mx-auto h-10 w-10 justify-center' : nested ? 'py-1.5 pe-3 ps-3' : 'px-3 py-2',
      active
        ? 'bg-sidebar-active font-semibold text-primary'
        : 'text-sidebar-muted hover:bg-muted hover:text-sidebar-foreground',
    );

  /** A group's heading and, while open, the links in it, indented under a guide line. */
  const renderGroup = (item: NavItem) => {
    const children = item.children ?? [];
    const containsActive = isActive(item);
    const open = !closedGroups.includes(item.to);
    const listId = `sidebar-group-${item.to.replace(/[^a-z0-9]+/gi, '-')}`;

    // Folded to icons there is no room for the links: the icon opens the group's page.
    if (collapsed) {
      return (
        <li key={item.to}>
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to={item.to}
                onClick={onNavigate}
                aria-current={containsActive ? 'page' : undefined}
                className={linkClass(containsActive)}
              >
                <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                <span className="sr-only">{item.label}</span>
              </NavLink>
            </TooltipTrigger>
            <TooltipContent side={isRightToLeft() ? 'left' : 'right'}>{item.label}</TooltipContent>
          </Tooltip>
        </li>
      );
    }

    return (
      <li key={item.to}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() =>
            setClosedGroups((current) => (open ? [...current, item.to] : current.filter((to) => to !== item.to)))
          }
          className={cn(
            'flex w-full items-center gap-3 rounded-lg px-3 py-2 font-display text-[0.8125rem] font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar',
            containsActive && !open
              ? 'bg-sidebar-active font-semibold text-primary'
              : containsActive
                ? 'font-semibold text-sidebar-foreground hover:bg-muted'
                : 'text-sidebar-muted hover:bg-muted hover:text-sidebar-foreground',
          )}
        >
          <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
          <span className="truncate">{item.label}</span>
          <ChevronDown
            className={cn('ms-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200', !open && '-rotate-90 rtl:rotate-90')}
            aria-hidden
          />
        </button>
        <AnimatePresence initial={false}>
          {open ? (
            <motion.ul
              id={listId}
              key="children"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
              className="ms-[1.4rem] mt-0.5 space-y-0.5 overflow-hidden border-s border-sidebar-border ps-2"
            >
              {children.map((child) => {
                const active = isActive(child);
                return (
                  <li key={child.to}>
                    <NavLink
                      to={child.to}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={linkClass(active, true)}
                    >
                      {active ? (
                        <motion.span
                          layoutId="sidebar-active-indicator"
                          className="absolute inset-y-1 start-0 w-1 rounded-full bg-primary"
                          transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                          aria-hidden
                        />
                      ) : null}
                      <span className="truncate">{child.label}</span>
                    </NavLink>
                  </li>
                );
              })}
            </motion.ul>
          ) : null}
        </AnimatePresence>
      </li>
    );
  };

  return (
    <motion.aside
      animate={{ width: variant === 'sheet' ? '100%' : collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
      initial={false}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      className={cn(
        'flex h-full flex-col border-e border-sidebar-border bg-sidebar',
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
        aria-label={t('Primary')}
        className={cn('epm-scroll relative flex-1 overflow-y-auto py-3', collapsed ? 'px-2' : 'px-3')}
      >
        {sections.map((section, sectionIndex) => (
          <div key={section.title ?? `section-${sectionIndex}`} className={cn(sectionIndex > 0 && 'mt-4')}>
            {section.title && !collapsed ? (
              <p className="px-3 pb-1.5 font-display text-2xs font-semibold uppercase tracking-[0.09em] text-sidebar-muted">
                {section.title}
              </p>
            ) : null}
            {section.title && collapsed ? (
              <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border" aria-hidden />
            ) : null}

            <ul className="space-y-0.5">
              {section.items.map((item) => {
                if (item.children) return renderGroup(item);

                const active = isActive(item);
                const badgeCount = item.badge === 'notifications' ? unread : item.badge === 'approvals' ? waiting : 0;

                const link = (
                  <NavLink
                    to={item.to}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={linkClass(active)}
                  >
                    {active ? (
                      <motion.span
                        layoutId="sidebar-active-indicator"
                        className="absolute inset-y-1 start-0 w-1 rounded-full bg-primary"
                        transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                        aria-hidden
                      />
                    ) : null}
                    <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                    {!collapsed ? <span className="truncate">{item.label}</span> : null}
                    {badgeCount > 0 ? (
                      collapsed ? (
                        <span
                          className="absolute end-1 top-1 h-2 w-2 rounded-full bg-danger ring-2 ring-sidebar"
                          aria-hidden
                        />
                      ) : (
                        <CountBadge count={badgeCount} max={9} className="ms-auto" />
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
                        <TooltipContent side={isRightToLeft() ? 'left' : 'right'}>
                          {badgeCount > 0
                            ? item.badge === 'approvals'
                              ? t('{label} · {count, number} waiting', { label: item.label, count: badgeCount })
                              : t('{label} · {count, number} unread', { label: item.label, count: badgeCount })
                            : item.label}
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

        {featureFlags.pragnya ? (
          <div className={cn('mt-4', collapsed ? '' : 'px-0.5')}>
            <button
              type="button"
              onClick={() => {
                onNavigate?.();
                openPragnya();
              }}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border border-dashed border-highlight/40 text-[0.8125rem] font-medium text-highlight-strong transition-colors hover:bg-highlight-soft',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                collapsed ? 'mx-auto h-10 w-10 justify-center' : 'px-3 py-2',
              )}
            >
              <Sparkles className="h-[18px] w-[18px] shrink-0" aria-hidden />
              {!collapsed ? <span>Pragnya</span> : <span className="sr-only">Pragnya</span>}
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
          <UserAvatar user={user} size="default" showStatus />
          {!collapsed ? (
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.8125rem] font-medium text-sidebar-foreground">
                {user?.name ?? t('Loading…')}
              </p>
              <p className="truncate text-xs text-sidebar-muted">{roleLabel(role)}</p>
            </div>
          ) : null}
        </div>

        {variant === 'fixed' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? t('Expand sidebar') : t('Collapse sidebar')}
            aria-expanded={!sidebarCollapsed}
            className={cn('mt-2 w-full text-xs text-sidebar-muted', collapsed && 'justify-center px-0')}
          >
            {sidebarCollapsed ? (
              <ChevronsRight className="h-3.5 w-3.5" />
            ) : (
              <>
                <ChevronsLeft className="h-3.5 w-3.5" />
                {t('Collapse')}
              </>
            )}
          </Button>
        ) : null}
      </div>
    </motion.aside>
  );
}
