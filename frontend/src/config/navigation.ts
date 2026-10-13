import {
  BarChart3,
  Bell,
  BookOpen,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  Coins,
  Landmark,
  GitCompare,
  FileText,
  FolderKanban,
  GanttChartSquare,
  Gauge,
  LayoutDashboard,
  Layers,
  ListTodo,
  MailCheck,
  Megaphone,
  PieChart,
  Plug,
  ScrollText,
  Settings,
  ShieldCheck,
  SquareKanban,
  Timer,
  Users,
  Building2,
  UserRound,
  UsersRound,
  Briefcase,
  type LucideIcon,
} from 'lucide-react';
import { t } from '@/lib/i18n';
import type { Permission } from '@/types';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Match nested routes as well, e.g. /projects/:id under /projects. */
  matchNested?: boolean;
  /** Renders a live count: unread notifications, or approvals waiting on the person. */
  badge?: 'notifications' | 'approvals';
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
    items: [{ get label() { return t('Overview'); }, to: '/dashboard', icon: LayoutDashboard }],
  },
  {
    get title() { return t('Work'); },
    items: [
      { get label() { return t('My Work'); }, to: '/my-work', icon: ListTodo },
      { get label() { return t('My Time'); }, to: '/my-time', icon: Timer },
      { get label() { return t('Timesheets'); }, to: '/timesheets', icon: CalendarClock, matchNested: true },
      { get label() { return t('Expenses'); }, to: '/expenses', icon: Coins, matchNested: true },
      { get label() { return t('Approvals'); }, to: '/approvals', icon: ClipboardCheck, matchNested: true, badge: 'approvals' },
      { get label() { return t('Projects'); }, to: '/projects', icon: FolderKanban, matchNested: true },
      { get label() { return t('Tasks'); }, to: '/tasks', icon: SquareKanban },
      { get label() { return t('Calendar'); }, to: '/calendar', icon: CalendarDays },
    ],
  },
  {
    get title() { return t('Delivery'); },
    items: [
      { get label() { return t('Agile'); }, to: '/agile', icon: Timer },
      { get label() { return t('Boards'); }, to: '/boards', icon: SquareKanban },
      { get label() { return t('Sprints'); }, to: '/sprints', icon: Gauge },
      { get label() { return t('Gantt'); }, to: '/gantt', icon: GanttChartSquare },
      { get label() { return t('Resources'); }, to: '/resources', icon: UsersRound, permission: 'resources:plan' },
    ],
  },
  {
    get title() { return t('Insights'); },
    items: [
      { get label() { return t('Dashboards'); }, to: '/insights', icon: PieChart, matchNested: true },
      { get label() { return t('Portfolio views'); }, to: '/portfolio-views', icon: Layers, matchNested: true },
      { get label() { return t('Scenarios'); }, to: '/scenarios', icon: GitCompare, matchNested: true, permission: 'scenarios:manage' },
      { get label() { return t('Reports'); }, to: '/reports', icon: FileText },
      { get label() { return t('Scheduled reports'); }, to: '/reports/scheduled', icon: MailCheck, permission: 'reports:schedule' },
      { get label() { return t('Time & Costs'); }, to: '/time-and-costs', icon: Coins },
      { get label() { return t('Finance'); }, to: '/finance', icon: Landmark, permission: 'finance:view' },
    ],
  },
  {
    get title() { return t('Collaboration'); },
    items: [
      { get label() { return t('Teams'); }, to: '/teams', icon: Users, matchNested: true },
      { get label() { return t('Meetings'); }, to: '/meetings', icon: CalendarClock, matchNested: true },
      { get label() { return t('News'); }, to: '/news', icon: Megaphone },
      { get label() { return t('Wiki'); }, to: '/wiki', icon: BookOpen, matchNested: true },
      { get label() { return t('Documents'); }, to: '/documents', icon: FileText },
    ],
  },
  {
    get title() { return t('Administration'); },
    items: [
      {
        get label() { return t('Administration'); },
        to: '/admin',
        icon: ShieldCheck,
        permission: 'users:manage',
        matchNested: true,
      },
      { get label() { return t('Portfolios'); }, to: '/portfolios', icon: Briefcase, permission: 'portfolios:manage' },
      { get label() { return t('Analytics'); }, to: '/analytics', icon: BarChart3, permission: 'analytics:manage' },
      { get label() { return t('Departments'); }, to: '/departments', icon: Building2, permission: 'departments:manage' },
      { get label() { return t('Employees'); }, to: '/employees', icon: UserRound, permission: 'employees:manage' },
      { get label() { return t('Integration'); }, to: '/settings/integration', icon: Plug, permission: 'users:manage' },
      { get label() { return t('Audit journal'); }, to: '/journal', icon: ScrollText, permission: 'audit:view' },
    ],
  },
  {
    get title() { return t('System'); },
    items: [
      { get label() { return t('Notifications'); }, to: '/notifications', icon: Bell, badge: 'notifications' },
      { get label() { return t('Settings'); }, to: '/settings', icon: Settings },
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
  // The title is translated, so it is compared in the language it is read in.
  const section = NAV_SECTIONS.find((candidate) => candidate.title === t('Administration'));
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
  { get label() { return t('Home'); }, to: '/dashboard', icon: LayoutDashboard },
  { get label() { return t('My Work'); }, to: '/my-work', icon: ListTodo },
  { get label() { return t('Projects'); }, to: '/projects', icon: FolderKanban, matchNested: true },
  { get label() { return t('Alerts'); }, to: '/notifications', icon: Bell, badge: 'notifications' },
];

/** Sub-navigation shown inside a project. */
export const PROJECT_TABS = [
  { get label() { return t('Overview'); }, segment: '' },
  { get label() { return t('Tasks'); }, segment: 'tasks' },
  { get label() { return t('Board'); }, segment: 'board' },
  { get label() { return t('Sprint'); }, segment: 'sprint' },
  { get label() { return t('Gantt'); }, segment: 'gantt' },
  { get label() { return t('Team'); }, segment: 'team' },
  { get label() { return t('Documents'); }, segment: 'documents' },
  { get label() { return t('Meetings'); }, segment: 'meetings' },
  { get label() { return t('News'); }, segment: 'news' },
  { get label() { return t('Wiki'); }, segment: 'wiki' },
  { get label() { return t('Activity'); }, segment: 'activity' },
  { get label() { return t('Reports'); }, segment: 'reports' },
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
  { id: 'profile', get label() { return t('Profile'); }, group: 'account' },
  { id: 'locale', get label() { return t('Language & region'); }, group: 'account' },
  { id: 'schedule', get label() { return t('Schedule'); }, group: 'account' },
  { id: 'appearance', get label() { return t('Appearance'); }, group: 'account' },
  { id: 'notifications', get label() { return t('Notifications'); }, group: 'account' },
  { id: 'security', get label() { return t('Security'); }, group: 'account' },
  { id: 'workspace', get label() { return t('Workspace'); }, group: 'administration' },
  { id: 'projects', get label() { return t('Projects'); }, group: 'administration' },
  { id: 'teams', get label() { return t('Teams'); }, group: 'administration' },
  { id: 'integrations', get label() { return t('Integrations'); }, group: 'administration' },
  { id: 'api', label: 'API', group: 'administration' },
] as const;

export type SettingsGroup = (typeof SETTINGS_SECTIONS)[number]['group'];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];
