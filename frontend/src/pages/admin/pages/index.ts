import { createElement, lazy, type LazyExoticComponent, type ComponentType } from 'react';

/**
 * The component behind every `live` administration page, keyed the way
 * `adminPageKey` in config/administration.ts builds keys: `"<areaId>/<pageId>"`,
 * or `"<areaId>"` for a single-page area. Pages of kind `managed` are not here;
 * AdministrationPage renders ManagedPanel for them.
 *
 * One file per page, named after the page. Two pages that show the same thing
 * (Attachments under System settings and under Files) share one component.
 * The pages that are a plain list of instance settings are the exception:
 * they are all `SettingsSectionPage` bound to a different section id.
 */

/**
 * A settings section as a page of its own. Bound inside `lazy` so the generic
 * page is still fetched only when one of these pages is opened.
 */
function settingsSection(section: string): LazyExoticComponent<ComponentType> {
  return lazy(async () => {
    const { SettingsSectionPage } = await import('./SettingsSectionPage');
    return { default: () => createElement(SettingsSectionPage, { section }) };
  });
}

/** A catalogue as a page of its own, bound the same way. */
function catalog(resource: string): LazyExoticComponent<ComponentType> {
  return lazy(async () => {
    const { CatalogPage } = await import('./CatalogPage');
    return { default: () => createElement(CatalogPage, { resource }) };
  });
}

export const ADMIN_PAGE_COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = {
  'users/settings': lazy(() => import('./UsersSettingsPage')),
  'users/users': lazy(() => import('./UsersPage')),
  'users/placeholder-users': lazy(() => import('./PlaceholderUsersPage')),
  'users/groups': lazy(() => import('./GroupsPage')),
  'users/roles': lazy(() => import('./RolesPage')),
  'users/permissions-report': lazy(() => import('./PermissionsReportPage')),
  'users/avatars': settingsSection('avatars'),
  'work-packages/settings': settingsSection('work-packages'),
  'work-packages/types': catalog('types'),
  'work-packages/statuses': catalog('statuses'),
  'work-packages/priorities': catalog('priorities'),
  'projects/list': lazy(() => import('./ProjectsListPage')),
  'projects/settings': settingsSection('projects'),
  'custom-fields': catalog('custom-fields'),
  'help-texts': lazy(() => import('./HelpTextsPage')),
  'calendars/working-days': lazy(() => import('./WorkingDaysPage')),
  'calendars/non-working-days': lazy(() => import('./NonWorkingDaysPage')),
  'calendars/date-format': lazy(() => import('./DateFormatPage')),
  'calendars/subscriptions': settingsSection('calendars'),
  'system/general': lazy(() => import('./GeneralSettingsPage')),
  'system/languages': settingsSection('languages'),
  'system/attachments': lazy(() => import('./AttachmentsPage')),
  'system/repositories': settingsSection('repositories'),
  'system/experimental': lazy(() => import('./ExperimentalPage')),
  'emails/notifications': settingsSection('emails'),
  'emails/incoming': settingsSection('incoming-emails'),
  'emails/aggregation': settingsSection('aggregation'),
  'api/api': lazy(() => import('./ApiPage')),
  'api/webhooks': catalog('webhooks'),
  'authentication/settings': settingsSection('authentication'),
  'authentication/oauth': catalog('oauth-applications'),
  announcement: lazy(() => import('./AnnouncementPage')),
  colors: lazy(() => import('./ColorsPage')),
  'time-and-costs/settings': lazy(() => import('./TimeAndCostsSettingsPage')),
  backlogs: lazy(() => import('./BacklogsPage')),
  'files/storages': lazy(() => import('./StoragesPage')),
  'files/attachments': lazy(() => import('./AttachmentsPage')),
  information: lazy(() => import('./InformationPage')),
};
