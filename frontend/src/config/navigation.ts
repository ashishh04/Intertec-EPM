import {
  BarChart3,
  Bell,
  CalendarDays,
  FileText,
  FolderKanban,
  GanttChartSquare,
  Gauge,
  LayoutDashboard,
  ListTodo,
  Settings,
  SquareKanban,
  Timer,
  Users,
  Building2,
  UserRound,
  Briefcase,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Match nested routes as well, e.g. /projects/:id under /projects. */
  matchNested?: boolean;
  /** Renders the live unread count when true. */
  badge?: 'notifications';
}

export interface NavSection {
  /** Section eyebrow. The first section is unlabelled. */
  title?: string;
  items: NavItem[];
}

/**
 * Primary navigation. The order is deliberate: overview, then the work the user
 * owns, then how it is delivered, then what it adds up to.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [{ label: 'Overview', to: '/dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Work',
    items: [
      { label: 'My Work', to: '/my-work', icon: ListTodo },
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
      { label: 'Portfolios', to: '/portfolios', icon: Briefcase },
      { label: 'Reports', to: '/reports', icon: FileText },
      { label: 'Analytics', to: '/analytics', icon: BarChart3 },
    ],
  },
  {
    title: 'Collaboration',
    items: [
      { label: 'Teams', to: '/teams', icon: Users, matchNested: true },
      { label: 'Departments', to: '/departments', icon: Building2 },
      { label: 'Employees', to: '/employees', icon: UserRound },
      { label: 'Documents', to: '/documents', icon: FileText },
    ],
  },
  {
    title: 'System',
    items: [
      { label: 'Notifications', to: '/notifications', icon: Bell, badge: 'notifications' },
      { label: 'Settings', to: '/settings', icon: Settings, matchNested: true },
    ],
  },
];

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
  { label: 'Activity', segment: 'activity' },
  { label: 'Reports', segment: 'reports' },
] as const;

/** Settings categories. `managedUpstream` marks settings owned by the delivery system. */
export const SETTINGS_SECTIONS = [
  { id: 'profile', label: 'Profile', managedUpstream: false },
  { id: 'appearance', label: 'Appearance', managedUpstream: false },
  { id: 'notifications', label: 'Notifications', managedUpstream: false },
  { id: 'workspace', label: 'Workspace', managedUpstream: false },
  { id: 'projects', label: 'Projects', managedUpstream: true },
  { id: 'teams', label: 'Teams', managedUpstream: true },
  { id: 'integrations', label: 'Integrations', managedUpstream: false },
  { id: 'security', label: 'Security', managedUpstream: true },
  { id: 'api', label: 'API', managedUpstream: true },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];
