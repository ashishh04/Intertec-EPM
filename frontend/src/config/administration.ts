import {
  Braces,
  CalendarDays,
  ClipboardList,
  DatabaseBackup,
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
  Palette,
  Puzzle,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from 'lucide-react';

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

/** A single-page area: the page carries the area's own id, label and description. */
function single(
  id: string,
  label: string,
  description: string,
  icon: LucideIcon,
  kind: AdminPageKind,
): AdminArea {
  return { id, label, description, icon, pages: [{ id, label, kind, description }] };
}

export const ADMIN_AREAS: AdminArea[] = [
  {
    id: 'users',
    label: 'Users and permissions',
    description: 'Who can sign in, how they are grouped, and what each role may do.',
    icon: Users,
    pages: [
      {
        id: 'settings',
        label: 'Users settings',
        kind: 'live',
        description: 'Defaults applied to every new account, such as language and self-registration.',
      },
      {
        id: 'users',
        label: 'Users',
        kind: 'live',
        description: 'Every account on the instance, with its status and global role.',
      },
      {
        id: 'placeholder-users',
        label: 'Placeholder users',
        kind: 'live',
        description: 'Named stand-ins that hold assignments before a real person is known.',
      },
      {
        id: 'groups',
        label: 'Groups',
        kind: 'live',
        description: 'Named sets of users that can be added to projects as one.',
      },
      {
        id: 'roles',
        label: 'Roles and permissions',
        kind: 'live',
        description: 'The roles a member can hold in a project and what each allows.',
      },
      {
        id: 'permissions-report',
        label: 'Permissions report',
        kind: 'live',
        description: 'A matrix of every permission against every role.',
      },
      {
        id: 'avatars',
        label: 'Avatars',
        kind: 'live',
        description: 'Whether people may upload a picture or use a Gravatar.',
      },
    ],
  },
  {
    id: 'work-packages',
    label: 'Work packages',
    description: 'The types, statuses and priorities every task is made from.',
    icon: ClipboardList,
    pages: [
      {
        id: 'settings',
        label: 'Settings',
        kind: 'live',
        description: 'Instance-wide behaviour of work packages, such as progress calculation.',
      },
      {
        id: 'types',
        label: 'Types',
        kind: 'live',
        description: 'The kinds of work package a project can create, such as Task or Milestone.',
      },
      {
        id: 'statuses',
        label: 'Status',
        kind: 'live',
        description: 'The states a work package moves through and which of them count as closed.',
      },
      {
        id: 'priorities',
        label: 'Priorities',
        kind: 'live',
        description: 'The urgency levels a work package can carry.',
      },
      {
        id: 'custom-actions',
        label: 'Custom actions',
        enterprise: true,
        kind: 'managed',
        description: 'One-click buttons that apply several changes to a work package at once.',
      },
    ],
  },
  {
    id: 'projects',
    label: 'Projects',
    description: 'Every project on the instance, and how new ones are set up.',
    icon: FolderKanban,
    pages: [
      {
        id: 'list',
        label: 'Projects',
        kind: 'live',
        description: 'All projects, including archived ones, with archive, restore and delete.',
      },
      {
        id: 'settings',
        label: 'Settings',
        kind: 'live',
        description: 'Defaults for new projects, such as enabled modules and visibility.',
      },
      {
        id: 'attributes',
        label: 'Project attributes',
        kind: 'managed',
        description: 'Extra fields shown on every project overview.',
      },
      {
        id: 'lists',
        label: 'Project lists',
        kind: 'managed',
        description: 'Saved, shareable views of the project list.',
      },
    ],
  },
  single(
    'custom-fields',
    'Custom fields',
    'Additional fields on work packages, projects, users and other records.',
    SlidersHorizontal,
    'live',
  ),
  single(
    'help-texts',
    'Attribute help texts',
    'The explanatory text shown beside a field when someone asks for help.',
    HelpCircle,
    'live',
  ),
  {
    id: 'calendars',
    label: 'Calendars and dates',
    description: 'Which days count as working days, and how dates are shown.',
    icon: CalendarDays,
    pages: [
      {
        id: 'working-days',
        label: 'Working days and hours',
        kind: 'live',
        description: 'The days of the week on which work is scheduled.',
      },
      {
        id: 'non-working-days',
        label: 'Non-working days',
        kind: 'live',
        description: 'Public holidays and other dates that scheduling skips.',
      },
      {
        id: 'date-format',
        label: 'Date format',
        kind: 'live',
        description: 'How dates, times and durations are formatted across the instance.',
      },
      {
        id: 'subscriptions',
        label: 'Calendar subscriptions',
        kind: 'live',
        description: 'Whether people may subscribe to calendars from outside the instance.',
      },
    ],
  },
  {
    id: 'system',
    label: 'System settings',
    description: 'Instance-wide settings: name, host, attachments and feature flags.',
    icon: Settings2,
    pages: [
      {
        id: 'general',
        label: 'General',
        kind: 'live',
        description: 'The instance name, host name and other values shared by every page.',
      },
      {
        id: 'languages',
        label: 'Languages',
        kind: 'live',
        description: 'The languages people may choose for the interface.',
      },
      {
        id: 'attachments',
        label: 'Attachments',
        kind: 'live',
        description: 'The size limit and other rules for files attached to records.',
      },
      {
        id: 'repositories',
        label: 'Repositories',
        kind: 'live',
        description: 'Source-code repositories linked to projects.',
      },
      {
        id: 'experimental',
        label: 'Experimental',
        kind: 'live',
        description: 'Feature flags currently switched on for this instance.',
      },
    ],
  },
  {
    id: 'emails',
    label: 'Emails and notifications',
    description: 'What the instance sends by email, and what it accepts.',
    icon: Mail,
    pages: [
      {
        id: 'notifications',
        label: 'Email notifications',
        kind: 'live',
        description: 'The sender address and the events that produce an email.',
      },
      {
        id: 'incoming',
        label: 'Incoming emails',
        kind: 'live',
        description: 'How replies and new messages sent by email are turned into records.',
      },
      {
        id: 'aggregation',
        label: 'Aggregation',
        kind: 'live',
        description: 'How long changes are bundled before one notification is sent.',
      },
    ],
  },
  {
    id: 'api',
    label: 'API and webhooks',
    description: 'How other systems read from and are told about this instance.',
    icon: Braces,
    pages: [
      {
        id: 'api',
        label: 'API',
        kind: 'live',
        description: 'The EPM API base and the version of the instance API behind it.',
      },
      {
        id: 'webhooks',
        label: 'Webhooks',
        kind: 'live',
        description: 'Outbound calls made when records change.',
      },
    ],
  },
  {
    id: 'authentication',
    label: 'Authentication',
    description: 'How people prove who they are when they sign in.',
    icon: KeyRound,
    pages: [
      {
        id: 'settings',
        label: 'Settings',
        kind: 'live',
        description: 'Password rules, session lifetime and self-registration.',
      },
      {
        id: 'ldap',
        label: 'LDAP authentication',
        // Not Enterprise. LDAP is in the free edition; it is `managed` here only
        // because OpenProject 15 exposes no API for it — `/api/v3/ldap_auth_sources`
        // is a 404. Marking it Enterprise told administrators to buy a licence
        // for something they already have.
        kind: 'managed',
        managedAt: 'Authentication → LDAP connections',
        description: 'Directory servers that accounts are checked against.',
      },
      {
        id: 'oauth',
        label: 'OAuth applications',
        kind: 'live',
        description: 'Applications allowed to act on behalf of signed-in people.',
      },
      {
        id: 'openid',
        label: 'OpenID providers',
        enterprise: true,
        kind: 'managed',
        managedAt: 'Authentication → OpenID providers',
        description: 'External identity providers that can sign people in.',
      },
      {
        id: 'saml',
        label: 'SAML providers',
        enterprise: true,
        kind: 'managed',
        managedAt: 'Authentication → SAML providers',
        description: 'Enterprise single sign-on providers.',
      },
      {
        id: 'two-factor',
        label: 'Two-factor authentication',
        kind: 'managed',
        managedAt: 'Authentication → Two-factor authentication',
        description: 'Whether a second factor is offered or required at sign-in.',
      },
      {
        id: 'recaptcha',
        label: 'reCAPTCHA',
        kind: 'managed',
        managedAt: 'Authentication → reCAPTCHA',
        description: 'The challenge shown to keep automated sign-ins out.',
      },
    ],
  },
  single(
    'announcement',
    'Announcement',
    'News posted for everyone on the instance to see.',
    Megaphone,
    'live',
  ),
  single(
    'design',
    'Design',
    'The logo, colours and favicon that brand the instance.',
    Palette,
    'managed',
  ),
  single(
    'colors',
    'Colors',
    'The colours in use by types, statuses and priorities.',
    Paintbrush,
    'live',
  ),
  // `live`: EPM already reads the licence state to decide whether to offer
  // Enterprise-gated actions, so the page shows it rather than rendering an
  // empty card. It still cannot apply a token — there is no API for that.
  single(
    'enterprise',
    'Enterprise edition',
    'The support token that unlocks enterprise features.',
    ShieldCheck,
    'live',
  ),
  {
    id: 'time-and-costs',
    label: 'Time and costs',
    description: 'How time is logged and how costs are calculated.',
    icon: Hourglass,
    pages: [
      {
        id: 'settings',
        label: 'Settings',
        kind: 'live',
        description: 'Hours per day and days per month used to convert durations.',
      },
      {
        id: 'activities',
        label: 'Time tracking activities',
        kind: 'managed',
        description: 'The kinds of work a time entry can be logged against.',
      },
      {
        id: 'cost-types',
        label: 'Cost types',
        kind: 'managed',
        description: 'Units of non-labour cost and their rates.',
      },
    ],
  },
  single(
    'backlogs',
    'Backlogs',
    'The versions that sprints and product backlogs are planned into.',
    Layers,
    'live',
  ),
  {
    id: 'files',
    label: 'Files',
    description: 'Where attachments live and which external storages are connected.',
    icon: HardDrive,
    pages: [
      {
        id: 'storages',
        label: 'External file storages',
        kind: 'live',
        description: 'Nextcloud, OneDrive and other storages projects can link files from.',
      },
      {
        id: 'attachments',
        label: 'Attachments',
        kind: 'live',
        description: 'The size limit and other rules for files attached to records.',
      },
    ],
  },
  single(
    'plugins',
    'Plugins',
    'The extensions installed on the instance.',
    Puzzle,
    'managed',
  ),
  single(
    'backup',
    'Backup',
    'On-demand backups of the instance database and attachments.',
    DatabaseBackup,
    'managed',
  ),
  single(
    'information',
    'Information',
    'The version and configuration of the instance behind EPM.',
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
