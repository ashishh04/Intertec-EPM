import {
  BarChart3,
  Braces,
  CalendarDays,
  ClipboardList,
  FolderKanban,
  HardDrive,
  HelpCircle,
  Hourglass,
  Info,
  KeyRound,
  Layers,
  Mail,
  Megaphone,
  Paintbrush,
  Settings2,
  SlidersHorizontal,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { msg, t } from '@/lib/i18n';

/**
 * Administration, as data.
 *
 * The shape mirrors OpenProject 15.5: an overview of areas, and inside each
 * area a sub-navigation of pages. `kind` says whether EPM can show live data
 * through its backend (`live`) or can only describe the setting (`managed`). See docs/administration-design.md.
 */

export type AdminPageKind = 'live' | 'managed';

export interface AdminPage {
  id: string;
  label: string;
  kind: AdminPageKind;
  /**
   * Gated behind an OpenProject Enterprise licence, which this instance does
   * not hold. Marked so the page can say so: a feature that cannot be bought
   * with code reads as an unfinished screen otherwise, and gets reported as a
   * bug for as long as nobody says why.
   */
  enterprise?: true;
  /**
   * Where a `managed` setting is actually changed, as a path through the
   * OpenProject administration. Without it the page can only say "not here",
   * which is the half of the answer nobody needed.
   */
  managedAt?: string;
  /** One sentence on what this page controls. */
  description: string;
}

export interface AdminArea {
  id: string;
  label: string;
  /** One sentence on what this area controls. */
  description: string;
  icon: LucideIcon;
  /**
   * The pages of the area, in the order they are shown. An area with exactly
   * one page is a single-page area: the page is the area, and it is routed by
   * the area id alone.
   */
  pages: AdminPage[];
}

/**
 * A single-page area: the page carries the area's own id, label and description.
 * Both arrive marked with `msg()` and are translated when read, not here at load.
 */
function single(
  id: string,
  label: string,
  description: string,
  icon: LucideIcon,
  kind: AdminPageKind,
): AdminArea {
  return {
    id,
    get label() { return t(label); },
    get description() { return t(description); },
    icon,
    pages: [{ id, get label() { return t(label); }, kind, get description() { return t(description); } }],
  };
}

export const ADMIN_AREAS: AdminArea[] = [
  {
    id: 'users',
    get label() { return t('Users and permissions'); },
    get description() { return t('Who can sign in, how they are grouped, and what each role may do.'); },
    icon: Users,
    pages: [
      {
        id: 'settings',
        get label() { return t('Users settings'); },
        kind: 'live',
        get description() { return t('Defaults applied to every new account, such as language and self-registration.'); },
      },
      {
        id: 'users',
        get label() { return t('Users'); },
        kind: 'live',
        get description() { return t('Every account on the instance, with its status, its last sign-in and its attributes.'); },
      },
      {
        id: 'user-attributes',
        get label() { return t('User attributes'); },
        kind: 'live',
        get description() { return t('Information kept on each person beyond their account, such as a job title or a skill.'); },
      },
      {
        id: 'placeholder-users',
        get label() { return t('Placeholder users'); },
        kind: 'live',
        get description() { return t('Named stand-ins that hold assignments before a real person is known.'); },
      },
      {
        id: 'resource-roles',
        get label() { return t('Resource roles'); },
        kind: 'live',
        get description() { return t('The kinds of work people do, for reading capacity, demand and utilisation by role.'); },
      },
      {
        id: 'resource-rules',
        get label() { return t('Resource rules'); },
        kind: 'live',
        get description() { return t('Heatmap thresholds, what counts as billable time, and the length of a working day.'); },
      },
      {
        id: 'groups',
        get label() { return t('Groups'); },
        kind: 'live',
        get description() { return t('Named sets of users that can be added to projects as one.'); },
      },
      {
        id: 'organization',
        get label() { return t('Organization'); },
        kind: 'live',
        get description() { return t('The company’s structure: departments, the teams inside them, and who sits where.'); },
      },
      {
        id: 'roles',
        get label() { return t('Roles and permissions'); },
        kind: 'live',
        get description() { return t('The roles a member can hold in a project and what each allows.'); },
      },
      {
        id: 'permissions-report',
        get label() { return t('Permissions report'); },
        kind: 'live',
        get description() { return t('A matrix of every permission against every role.'); },
      },
      {
        id: 'epm-permissions',
        get label() { return t('EPM permissions'); },
        kind: 'live',
        get description() {
          return t('EPM\'s own permissions — staffing, health, rules, rates, the audit journal — and who holds each.');
        },
      },
      {
        id: 'avatars',
        get label() { return t('Avatars'); },
        kind: 'live',
        get description() { return t('Whether people may upload a picture or use a Gravatar.'); },
      },
    ],
  },
  {
    id: 'work-packages',
    get label() { return t('Work packages'); },
    get description() { return t('The types, statuses and priorities every task is made from.'); },
    icon: ClipboardList,
    pages: [
      {
        id: 'settings',
        get label() { return t('Settings'); },
        kind: 'live',
        get description() { return t('Instance-wide behaviour of work packages, such as highlighting, relations and exports.'); },
      },
      {
        id: 'types',
        get label() { return t('Types'); },
        kind: 'live',
        get description() { return t('The kinds of work package a project can create, such as Task or Milestone.'); },
      },
      {
        id: 'statuses',
        get label() { return t('Status'); },
        kind: 'live',
        get description() { return t('The states a work package moves through and which of them count as closed.'); },
      },
      {
        id: 'priorities',
        get label() { return t('Priorities'); },
        kind: 'live',
        get description() { return t('The urgency levels a work package can carry.'); },
      },
      {
        id: 'progress-tracking',
        get label() { return t('Progress tracking'); },
        kind: 'live',
        get description() { return t('How % Complete is worked out on each work package, and how it adds up a hierarchy.'); },
      },
      {
        id: 'identifiers',
        get label() { return t('Identifiers'); },
        kind: 'live',
        get description() { return t('How work packages are named across EPM, and the project identifiers their prefixes come from.'); },
      },
      {
        id: 'approval-chains',
        get label() { return t('Approval chains'); },
        kind: 'live',
        get description() {
          return t('Who approves which work packages, in which order: steps, conditions, SLAs and who hears when one is missed.');
        },
      },
      {
        id: 'calculated-fields',
        get label() { return t('Calculated fields'); },
        kind: 'live',
        get description() {
          return t('Formulas EPM works out on every work package — remaining effort, days late, roll-ups of the children — that every view can show, filter, group and sum.');
        },
      },
    ],
  },
  {
    id: 'projects',
    get label() { return t('Projects'); },
    get description() { return t('Every project on the instance, and how new ones are set up.'); },
    icon: FolderKanban,
    pages: [
      {
        id: 'list',
        get label() { return t('Projects'); },
        kind: 'live',
        get description() { return t('All projects, including archived ones, with archive, restore and delete.'); },
      },
      {
        id: 'settings',
        get label() { return t('Settings'); },
        kind: 'live',
        get description() { return t('Defaults for new projects, such as enabled modules and visibility.'); },
      },
      {
        id: 'health-rules',
        get label() { return t('Health rules'); },
        kind: 'live',
        get description() {
          return t('How project health is calculated: the criteria, their weights and thresholds, and what counts as a high risk.');
        },
      },
      {
        id: 'earned-value',
        get label() { return t('Earned value'); },
        kind: 'live',
        get description() { return t('How each type of work earns value, and the rate for work no one’s rate prices.'); },
      },
    ],
  },
  {
    id: 'automation',
    get label() { return t('Rules and escalation'); },
    get description() { return t('Rules that act on work as it changes, and who is chased when work stalls.'); },
    icon: Workflow,
    pages: [
      {
        id: 'rules',
        get label() { return t('Rules'); },
        kind: 'live',
        get description() {
          return t(
            'When work or a project changes and matches a rule, the rule acts — assigns, moves the status, sets a field, creates linked work, notifies or calls out — as the automation account.',
          );
        },
      },
      {
        id: 'escalation',
        get label() { return t('Escalation'); },
        kind: 'live',
        get description() {
          return t(
            'Escalation paths for work left untouched, work overdue and approvals past their SLA: who is told at each level, and what has been escalated.',
          );
        },
      },
    ],
  },
  single(
    'analytics',
    msg('Analytics model'),
    msg('How fresh the reporting model is, every refresh and how it reconciled to its source, the daily captures history is checked against, and the read-only role BI tools use.'),
    BarChart3,
    'live',
  ),
  single(
    'custom-fields',
    msg('Custom fields'),
    msg('Additional fields on work packages, projects, users and other records.'),
    SlidersHorizontal,
    'live',
  ),
  single(
    'help-texts',
    msg('Attribute help texts'),
    msg('The explanatory text shown beside a field when someone asks for help.'),
    HelpCircle,
    'live',
  ),
  {
    id: 'calendars',
    get label() { return t('Calendars and dates'); },
    get description() { return t('Which days count as working days, and how dates are shown.'); },
    icon: CalendarDays,
    pages: [
      {
        id: 'working-days',
        get label() { return t('Working days and hours'); },
        kind: 'live',
        get description() { return t('The days of the week on which work is scheduled.'); },
      },
      {
        id: 'non-working-days',
        get label() { return t('Non-working days'); },
        kind: 'live',
        get description() { return t('Public holidays and other dates that scheduling skips.'); },
      },
      {
        id: 'date-format',
        get label() { return t('Date format'); },
        kind: 'live',
        get description() { return t('How dates, times and durations are formatted across the instance.'); },
      },
      {
        id: 'subscriptions',
        get label() { return t('Calendar subscriptions'); },
        kind: 'live',
        get description() { return t('Whether people may subscribe to calendars from outside the instance.'); },
      },
    ],
  },
  {
    id: 'system',
    get label() { return t('System settings'); },
    get description() { return t('Instance-wide settings: name, host, attachments and feature flags.'); },
    icon: Settings2,
    pages: [
      {
        id: 'general',
        get label() { return t('General'); },
        kind: 'live',
        get description() { return t('The instance name, host name and other values shared by every page.'); },
      },
      {
        id: 'languages',
        get label() { return t('Languages'); },
        kind: 'live',
        get description() { return t('The languages people may choose for the interface.'); },
      },
      {
        id: 'attachments',
        get label() { return t('Attachments'); },
        kind: 'live',
        get description() { return t('The size limit and other rules for files attached to records.'); },
      },
      {
        id: 'repositories',
        get label() { return t('Repositories'); },
        kind: 'live',
        get description() { return t('Source-code repositories linked to projects.'); },
      },
      {
        id: 'experimental',
        get label() { return t('Experimental'); },
        kind: 'live',
        get description() { return t('Feature flags currently switched on for this instance.'); },
      },
    ],
  },
  {
    id: 'emails',
    get label() { return t('Emails and notifications'); },
    get description() { return t('What the instance sends by email, and what it accepts.'); },
    icon: Mail,
    pages: [
      {
        id: 'notifications',
        get label() { return t('Email notifications'); },
        kind: 'live',
        get description() { return t('The sender address and the events that produce an email.'); },
      },
      {
        id: 'incoming',
        get label() { return t('Incoming emails'); },
        kind: 'live',
        get description() { return t('How replies and new messages sent by email are turned into records.'); },
      },
      {
        id: 'aggregation',
        get label() { return t('Aggregation'); },
        kind: 'live',
        get description() { return t('How long changes are bundled before one notification is sent.'); },
      },
    ],
  },
  {
    id: 'api',
    get label() { return t('API and webhooks'); },
    get description() { return t('How other systems read from and are told about this instance.'); },
    icon: Braces,
    pages: [
      {
        id: 'api',
        get label() { return t('API'); },
        kind: 'live',
        get description() { return t('The EPM API base and the version of the instance API behind it.'); },
      },
      {
        id: 'webhooks',
        get label() { return t('Webhooks'); },
        kind: 'live',
        get description() { return t('Outbound calls made when records change.'); },
      },
    ],
  },
  {
    id: 'authentication',
    get label() { return t('Authentication'); },
    get description() { return t('How people prove who they are when they sign in.'); },
    icon: KeyRound,
    pages: [
      {
        id: 'settings',
        get label() { return t('Settings'); },
        kind: 'live',
        get description() { return t('Password rules, session lifetime and self-registration.'); },
      },
      // LDAP, OpenID, SAML, two-factor and reCAPTCHA are not listed: none can be
      // read or changed through EPM, so their pages could only send people to
      // the delivery system's own administration, which EPM never shows.
      {
        id: 'oauth',
        get label() { return t('OAuth applications'); },
        kind: 'live',
        get description() { return t('Applications allowed to act on behalf of signed-in people.'); },
      },
    ],
  },
  single(
    'announcement',
    msg('Announcement'),
    msg('News posted for everyone on the instance to see.'),
    Megaphone,
    'live',
  ),
  // Design and the Enterprise edition are not listed: the first cannot be
  // changed through EPM, and the second is about the delivery system's own
  // licence — neither has anything an EPM administrator can act on.
  single(
    'colors',
    msg('Colors'),
    msg('The colours in use by types, statuses and priorities.'),
    Paintbrush,
    'live',
  ),
  {
    id: 'time-and-costs',
    get label() { return t('Time and costs'); },
    get description() { return t('How time is logged and how costs are calculated.'); },
    icon: Hourglass,
    pages: [
      {
        id: 'settings',
        get label() { return t('Settings'); },
        kind: 'live',
        get description() { return t('Hours per day and days per month used to convert durations.'); },
      },
      {
        id: 'rules',
        get label() { return t('Timesheets, policies and expenses'); },
        kind: 'live',
        get description() { return t('The timesheet period and its hours, the time logging policies, and the receipt threshold for claims.'); },
      },
      {
        id: 'cost-types',
        get label() { return t('Cost types'); },
        kind: 'live',
        get description() { return t('Units of non-labour cost and their rates; expense claims are made under them.'); },
      },
    ],
  },
  single(
    'backlogs',
    msg('Backlogs'),
    msg('The versions that sprints and product backlogs are planned into.'),
    Layers,
    'live',
  ),
  {
    id: 'files',
    get label() { return t('Files'); },
    get description() { return t('Where attachments live and which external storages are connected.'); },
    icon: HardDrive,
    pages: [
      {
        id: 'storages',
        get label() { return t('External file storages'); },
        kind: 'live',
        get description() { return t('Nextcloud, OneDrive and other storages projects can link files from.'); },
      },
      {
        id: 'attachments',
        get label() { return t('Attachments'); },
        kind: 'live',
        get description() { return t('The size limit and other rules for files attached to records.'); },
      },
    ],
  },
  // Plugins and Backup are not listed either: both live only in the delivery
  // system's own administration.
  single(
    'information',
    msg('Information'),
    msg('Which version of EPM this is, and where it runs.'),
    Info,
    'live',
  ),
];

export function findAdminArea(id: string | undefined): AdminArea | undefined {
  return id ? ADMIN_AREAS.find((area) => area.id === id) : undefined;
}

export function findAdminPage(area: AdminArea, pageId: string | undefined): AdminPage | undefined {
  return pageId ? area.pages.find((page) => page.id === pageId) : undefined;
}

export function firstAdminPage(area: AdminArea): AdminPage {
  return area.pages[0];
}

export function isSinglePageArea(area: AdminArea): boolean {
  return area.pages.length === 1;
}

/** Where an area opens: its own path, or its first page for multi-page areas. */
export function adminAreaPath(area: AdminArea): string {
  return isSinglePageArea(area)
    ? `/admin/${area.id}`
    : `/admin/${area.id}/${firstAdminPage(area).id}`;
}

export function adminPagePath(area: AdminArea, page: AdminPage): string {
  return isSinglePageArea(area) ? `/admin/${area.id}` : `/admin/${area.id}/${page.id}`;
}

/**
 * The key a page's component is registered under in `pages/admin/pages`:
 * `"<areaId>/<pageId>"`, or `"<areaId>"` for a single-page area.
 */
export function adminPageKey(area: AdminArea, page: AdminPage): string {
  return isSinglePageArea(area) ? area.id : `${area.id}/${page.id}`;
}
