import {
  BarChart3,
  Bell,
  BookOpen,
  CalendarClock,
  CalendarDays,
  Coins,
  FileText,
  FolderKanban,
  GanttChartSquare,
  Gauge,
  LayoutDashboard,
  ListTodo,
  Megaphone,
  Plug,
  Settings,
  ShieldCheck,
  SquareKanban,
  Timer,
  Users,
  Building2,
  UserRound,
  Briefcase,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@/types';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Match nested routes as well, e.g. /projects/:id under /projects. */
  matchNested?: boolean;
  /** Renders the live unread count when true. */
  badge?: 'notifications';
  /**
   * Shown only to people holding this global permission. The route behind it
   * is guarded on the same permission (see App.tsx), so hiding the link is a
   * courtesy, not the boundary.
   */
  permission?: Permission;
}

export interface NavSection {
  /** Section eyebrow. The first section is unlabelled. */
  title?: string;
  items: NavItem[];
}

/**
 * Primary navigation. The order is deliberate: overview, then the work the user
 * owns, then how it is delivered, then what it adds up to, then administration.
 *
 * The Administration section is the difference between an administrator's
 * sidebar and everyone else's. Its items each carry a permission, and the
 * section disappears entirely when none of them apply — a regular user is not
 * shown an empty heading for an area they cannot enter.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [{ label: 'Overview', to: '/dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Work',
    items: [
      { label: 'My Work', to: '/my-work', icon: ListTodo },
      { label: 'My Time', to: '/my-time', icon: Timer },
      { label: 'Projects', to: '/projects', icon: FolderKanban, matchNested: true },
      { label: 'Tasks', to: '/tasks', icon: SquareKanban },
      { label: 'Calendar', to: '/calendar', icon: CalendarDays },
    ],
  },
  {
    title: 'Delivery',
    items: [
      { label: 'Agile', to: '/agile', icon: Timer },
      { label: 'Boards', to: '/boards', icon: SquareKanban },
      { label: 'Sprints', to: '/sprints', icon: Gauge },
      { label: 'Gantt', to: '/gantt', icon: GanttChartSquare },
    ],
  },
  {
    title: 'Insights',
    items: [
      { label: 'Reports', to: '/reports', icon: FileText },
      { label: 'Time & Costs', to: '/time-and-costs', icon: Coins },
    ],
  },
  {
    title: 'Collaboration',
    items: [
      { label: 'Teams', to: '/teams', icon: Users, matchNested: true },
      { label: 'Meetings', to: '/meetings', icon: CalendarClock, matchNested: true },
      { label: 'News', to: '/news', icon: Megaphone },
      { label: 'Wiki', to: '/wiki', icon: BookOpen, matchNested: true },
      { label: 'Documents', to: '/documents', icon: FileText },
    ],
  },
  {
    title: 'Administration',
    items: [
      {
        label: 'Administration',
        to: '/admin',
        icon: ShieldCheck,
        permission: 'users:manage',
        matchNested: true,
      },
      { label: 'Portfolios', to: '/portfolios', icon: Briefcase, permission: 'portfolios:manage' },
      { label: 'Analytics', to: '/analytics', icon: BarChart3, permission: 'analytics:manage' },
      { label: 'Departments', to: '/departments', icon: Building2, permission: 'departments:manage' },
      { label: 'Employees', to: '/employees', icon: UserRound, permission: 'employees:manage' },
      { label: 'Integration', to: '/settings/integration', icon: Plug, permission: 'users:manage' },
    ],
  },
  {
    title: 'System',
    items: [
      { label: 'Notifications', to: '/notifications', icon: Bell, badge: 'notifications' },
      { label: 'Settings', to: '/settings', icon: Settings },
    ],
  },
];

/**
 * The sections a given person may see, with items they lack the permission for
 * removed and any section left empty dropped with them.
 */
export function visibleNavSections(can: (permission: Permission) => boolean): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.permission || can(item.permission)),
  })).filter((section) => section.items.length > 0);
}

/** The Administration section, filtered to what this person may open. */
export function adminNavItems(can: (permission: Permission) => boolean): NavItem[] {
  const section = NAV_SECTIONS.find((candidate) => candidate.title === 'Administration');
  return (section?.items ?? []).filter((item) => !item.permission || can(item.permission));
}

/**
 * Whether this person administers anything at all. This is what separates the
 * two experiences: an administrator gets the Administration hub, the admin
 * group in Settings and the extra entry in the account menu; everyone else
 * gets the same product without them.
 */
export function isAdministrator(can: (permission: Permission) => boolean): boolean {
  return adminNavItems(can).length > 0;
}

/** Condensed navigation for the mobile bottom bar. */
export const MOBILE_NAV_ITEMS: NavItem[] = [
  { label: 'Home', to: '/dashboard', icon: LayoutDashboard },
  { label: 'My Work', to: '/my-work', icon: ListTodo },
  { label: 'Projects', to: '/projects', icon: FolderKanban, matchNested: true },
  { label: 'Alerts', to: '/notifications', icon: Bell, badge: 'notifications' },
];

/** Sub-navigation shown inside a project. */
export const PROJECT_TABS = [
  { label: 'Overview', segment: '' },
  { label: 'Tasks', segment: 'tasks' },
  { label: 'Board', segment: 'board' },
  { label: 'Sprint', segment: 'sprint' },
  { label: 'Gantt', segment: 'gantt' },
  { label: 'Team', segment: 'team' },
  { label: 'Documents', segment: 'documents' },
  { label: 'Meetings', segment: 'meetings' },
  { label: 'News', segment: 'news' },
  { label: 'Wiki', segment: 'wiki' },
  { label: 'Activity', segment: 'activity' },
  { label: 'Reports', segment: 'reports' },
] as const;

/**
 * Settings categories. `group` splits the page the way OpenProject does: the
 * `account` group is identical for everyone, the `administration` group exists
 * only for administrators.
 *
 * Security sits in the account group, not administration. It used to be the
 * other way round, which put the one page where a person changes their own
 * password and ends a session on a lost laptop behind an administrator check —
 * so most of the workforce could not reach either.
 */
export const SETTINGS_SECTIONS = [
  { id: 'profile', label: 'Profile', group: 'account' },
  { id: 'locale', label: 'Language & region', group: 'account' },
  { id: 'schedule', label: 'Schedule', group: 'account' },
  { id: 'appearance', label: 'Appearance', group: 'account' },
  { id: 'notifications', label: 'Notifications', group: 'account' },
  { id: 'security', label: 'Security', group: 'account' },
  { id: 'workspace', label: 'Workspace', group: 'administration' },
  { id: 'projects', label: 'Projects', group: 'administration' },
  { id: 'teams', label: 'Teams', group: 'administration' },
  { id: 'integrations', label: 'Integrations', group: 'administration' },
  { id: 'api', label: 'API', group: 'administration' },
] as const;

export type SettingsGroup = (typeof SETTINGS_SECTIONS)[number]['group'];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];
