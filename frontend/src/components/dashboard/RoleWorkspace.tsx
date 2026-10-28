import { Link } from 'react-router-dom';
import {
  Building2,
  CalendarClock,
  ClipboardCheck,
  Coins,
  FileText,
  FolderKanban,
  Gauge,
  KeyRound,
  Landmark,
  Layers,
  ListTodo,
  PieChart,
  ScrollText,
  ShieldCheck,
  Timer,
  UserRound,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

import { Card } from '@/components/ui/card';
import { roleLabel } from '@/config/navigation';
import { useAuth } from '@/providers/AuthProvider';
import { t } from '@/lib/i18n';
import type { AppRole, Permission } from '@/types';

interface Shortcut {
  label: string;
  hint: string;
  to: string;
  icon: LucideIcon;
  /** Offered only to people holding it, whatever their role. */
  permission?: Permission;
}

/** The handful of places each role starts its day from. */
function shortcutsFor(role: AppRole): Shortcut[] {
  switch (role) {
    case 'admin':
      return [
        { label: t('Administration'), hint: t('Users, settings and integrations'), to: '/admin', icon: ShieldCheck },
        { label: t('Access roles'), hint: t('Who is a manager, HR or an employee'), to: '/admin/users/app-roles', icon: KeyRound, permission: 'users:manage' },
        { label: t('Audit journal'), hint: t('Every change, who made it'), to: '/journal', icon: ScrollText, permission: 'audit:view' },
        { label: t('Portfolios'), hint: t('Group projects for oversight'), to: '/portfolios', icon: Layers, permission: 'portfolios:manage' },
      ];
    case 'manager':
      return [
        { label: t('Approvals'), hint: t('Timesheets, expenses and changes waiting on you'), to: '/approvals', icon: ClipboardCheck },
        { label: t('Resources'), hint: t('Who is over or under loaded'), to: '/resources', icon: UsersRound, permission: 'resources:plan' },
        { label: t('Dashboards'), hint: t('Portfolio health and delivery'), to: '/insights', icon: PieChart },
        { label: t('Finance'), hint: t('Margin, revenue and billing'), to: '/finance', icon: Landmark, permission: 'finance:view' },
        { label: t('Reports'), hint: t('Delivery and status reports'), to: '/reports', icon: FileText },
      ];
    case 'hr':
      return [
        { label: t('Employees'), hint: t('Who sits where, capacity and rates'), to: '/employees', icon: UserRound, permission: 'employees:manage' },
        { label: t('Departments'), hint: t('The organisation\'s structure'), to: '/departments', icon: Building2, permission: 'departments:manage' },
        { label: t('Teams'), hint: t('Teams and their leads'), to: '/teams', icon: Users },
        { label: t('Timesheets'), hint: t('Who has not submitted'), to: '/timesheets', icon: CalendarClock },
        { label: t('Time & Costs'), hint: t('Hours across the organisation'), to: '/time-and-costs', icon: Coins },
      ];
    default:
      return [
        { label: t('My Work'), hint: t('What is assigned to you'), to: '/my-work', icon: ListTodo },
        { label: t('My Time'), hint: t('Log this week\'s hours'), to: '/my-time', icon: Timer },
        { label: t('Timesheets'), hint: t('Submit your timesheet'), to: '/timesheets', icon: CalendarClock },
        { label: t('Expenses'), hint: t('Claim what you spent'), to: '/expenses', icon: Coins },
        { label: t('Projects'), hint: t('The projects you are on'), to: '/projects', icon: FolderKanban },
      ];
  }
}

function headlineFor(role: AppRole): string {
  switch (role) {
    case 'admin':
      return t('Run the workspace: people, access and settings.');
    case 'manager':
      return t('Keep projects and people on track.');
    case 'hr':
      return t('Look after the organisation and its people.');
    default:
      return t('Your work, your time and your claims.');
  }
}

/**
 * The top of the Overview, different for each role: what the person is here
 * as, and the places that role starts from. The widgets below stay the
 * person's own arrangement.
 */
export function RoleWorkspace() {
  const { role, can } = useAuth();
  const shortcuts = shortcutsFor(role).filter((item) => !item.permission || can(item.permission));

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="epm-eyebrow flex items-center gap-1.5">
            <Gauge className="h-3.5 w-3.5" aria-hidden />
            {t('{role} workspace', { role: roleLabel(role) })}
          </p>
          <p className="mt-1 font-display text-sm font-semibold text-foreground">{headlineFor(role)}</p>
        </div>
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {shortcuts.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              className="group flex h-full items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 transition-colors hover:border-primary/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-foreground">{item.label}</span>
                <span className="block text-2xs text-muted-foreground">{item.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
