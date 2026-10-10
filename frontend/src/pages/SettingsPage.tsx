import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowRight,
  ExternalLink,
  Lock,
  RotateCcw,
  Server,
} from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { FactList } from '@/components/common/FactList';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useTimezones, useUpdateProfile } from '@/hooks/useUsers';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label, FieldHint } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LocaleSettings } from '@/components/settings/LocaleSettings';
import { NotificationSettings } from '@/components/settings/NotificationSettings';
import { ScheduleSettings } from '@/components/settings/ScheduleSettings';
import { SecuritySettings } from '@/components/settings/SecuritySettings';
import { ToggleRow } from '@/components/settings/SettingsRows';
import { SETTINGS_SECTIONS, isAdministrator, type SettingsSectionId } from '@/config/navigation';
import { useAuth } from '@/providers/AuthProvider';
import { usePreferences, type Preferences } from '@/hooks/usePreferences';
import { APP_NAME, ORG_NAME, env } from '@/config/env';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

/**
 * Enterprise settings. Sections owned by OpenProject are marked and read-only
 * here, so it is always clear which system is authoritative for a setting.
 */
export default function SettingsPage() {
  const { user, can } = useAuth();
  const administrator = isAdministrator(can);
  // The account group is the same for everyone; the administration group exists
  // only for administrators, exactly as the sidebar and the account menu do.
  const visibleSections = SETTINGS_SECTIONS.filter(
    (item) => item.group === 'account' || administrator,
  );

  // The section lives in the URL so the Administration hub, and anyone sharing
  // a link, can open one directly. An id this person may not see falls back to
  // Profile rather than rendering a blank page.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('section');
  const section: SettingsSectionId =
    visibleSections.find((item) => item.id === requested)?.id ?? 'profile';
  const setSection = (id: SettingsSectionId) =>
    setSearchParams(id === 'profile' ? {} : { section: id });

  // Toggles and selects write straight to the shared record, so there is no
  // "save" step to forget and the Profile page shows the same values.
  const { preferences, update, reset, isSaving } = usePreferences();

  const active = SETTINGS_SECTIONS.find((item) => item.id === section)!;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Settings')}
        description={t('Configure how {app} works for you and your workspace.', { app: APP_NAME })}
      />

      <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
        {/* Section navigation */}
        <nav aria-label={t('Settings sections')} className="lg:sticky lg:top-20 lg:self-start">
          <ul className="epm-scroll flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {visibleSections.map((item, index) => (
              <Fragment key={item.id}>
                {administrator && index === 0 ? (
                  <li className="hidden shrink-0 lg:block">
                    <p className="epm-eyebrow px-2.5 pb-1">{t('Account')}</p>
                  </li>
                ) : null}
                {item.group === 'administration' &&
                visibleSections[index - 1]?.group !== 'administration' ? (
                  <li className="hidden shrink-0 lg:block">
                    <p className="epm-eyebrow mt-3 px-2.5 pb-1">{t('Administration')}</p>
                  </li>
                ) : null}
                <li className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setSection(item.id)}
                    aria-current={section === item.id ? 'page' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-2 text-start text-xs font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      section === item.id
                        ? 'bg-primary-soft text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {item.label}
                  </button>
                </li>
              </Fragment>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-4">
          {section === 'profile' ? (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Profile')}</CardTitle>
                <CardDescription>{t('Your identity across the platform.')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                <div className="flex items-center gap-3">
                  <UserAvatar user={user} size="lg" />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{user?.name}</p>
                    <p className="text-2xs text-muted-foreground">{user?.role}</p>
                  </div>
                </div>

                <ProfileForm />

                <div className="space-y-1.5">
                  <Label htmlFor="settings-department">{t('Department')}</Label>
                  <Input id="settings-department" defaultValue={user?.department} readOnly />
                  <FieldHint>{t('Set by an administrator on the Employees page.')}</FieldHint>
                </div>

                <Button asChild variant="secondary" size="sm">
                  <Link to="/profile">
                    {t('Open profile')}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {section === 'appearance' ? (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Appearance')}</CardTitle>
                <CardDescription>{t('How EPM looks on this device.')}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {/* No theme picker: EPM follows the Intertec brand, which is a
                    single light identity. */}
                <div className="divide-y divide-border">
                  <ToggleRow
                    id="dense-tables"
                    label={t('Compact tables')}
                    hint={t('Reduce row height in work package tables.')}
                    checked={preferences.appearance.compactTables}
                    onCheckedChange={(checked) => update('appearance', 'compactTables', checked)}
                  />
                  <ToggleRow
                    id="reduced-motion"
                    label={t('Reduce motion')}
                    hint={t('Minimise transitions and animated chart entrances.')}
                    checked={preferences.appearance.reduceMotion}
                    onCheckedChange={(checked) => update('appearance', 'reduceMotion', checked)}
                  />
                  <ToggleRow
                    id="show-avatars"
                    label={t('Show avatars')}
                    hint={t('Faces beside names in lists and boards.')}
                    checked={preferences.appearance.showAvatars}
                    onCheckedChange={(checked) => update('appearance', 'showAvatars', checked)}
                  />
                </div>
              </CardContent>
            </Card>
          ) : null}

          {section === 'notifications' ? <NotificationSettings /> : null}

          {section === 'locale' ? <LocaleSettings /> : null}

          {section === 'schedule' ? <ScheduleSettings /> : null}

          {section === 'workspace' ? (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Workspace')}</CardTitle>
                <CardDescription>{t('Defaults applied across {org}.', { org: ORG_NAME })}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                <FactList
                  facts={[
                    { label: t('Organisation'), value: ORG_NAME, mono: false },
                    { label: t('Application'), value: APP_NAME, mono: false },
                    {
                      label: t('Environment'),
                      value: (
                        <Badge tone="highlight" size="sm" className="capitalize">
                          {env.appEnv}
                        </Badge>
                      ),
                      mono: false,
                    },
                  ]}
                />

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="workspace-landing">{t('Default landing page')}</Label>
                    <Select
                      value={preferences.workspace.landingPage}
                      onValueChange={(value) =>
                        update(
                          'workspace',
                          'landingPage',
                          value as Preferences['workspace']['landingPage'],
                        )
                      }
                    >
                      <SelectTrigger id="workspace-landing">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dashboard">{t('Overview')}</SelectItem>
                        <SelectItem value="my-work">{t('My Work')}</SelectItem>
                        <SelectItem value="projects">{t('Projects')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="workspace-week">{t('Week starts on')}</Label>
                    <Select
                      value={preferences.workweek.startOfWeek}
                      onValueChange={(value) =>
                        update(
                          'workweek',
                          'startOfWeek',
                          value as Preferences['workweek']['startOfWeek'],
                        )
                      }
                    >
                      <SelectTrigger id="workspace-week">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="monday">{t('Monday')}</SelectItem>
                        <SelectItem value="sunday">{t('Sunday')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <FieldHint>{isSaving ? t('Saving…') : t('Changes are saved as you make them.')}</FieldHint>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      // The failure toast comes from the hook; only the
                      // success is worth saying here.
                      reset().then(
                        () => toast.success(t('Preferences reset to defaults')),
                        () => undefined,
                      )
                    }
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t('Reset to defaults')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {section === 'projects' || section === 'teams' ? (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>{active.label}</CardTitle>
                <CardDescription>
                  {section === 'projects'
                    ? t('Project types, statuses, custom fields and work package types.')
                    : t('Groups, memberships and role assignments.')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                <FactList
                  facts={(section === 'projects'
                    ? [t('Work package types'), t('Statuses and workflows'), t('Custom fields'), t('Versions')]
                    : [t('Groups'), t('Roles and permissions'), t('Memberships'), t('Directory sync')]
                  ).map((item) => ({
                    label: item,
                    mono: false,
                    value: (
                      <Badge tone="neutral" size="sm">
                        <Lock className="h-2.5 w-2.5" aria-hidden />
                        {t('Managed')}
                      </Badge>
                    ),
                  }))}
                />
                <FieldHint>
                  {t(
                    'An administrator manages these in the upstream system. EPM reflects the values after the next synchronisation.',
                  )}
                </FieldHint>
              </CardContent>
            </Card>
          ) : null}

          {section === 'integrations' ? (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>{t('Integrations')}</CardTitle>
                <CardDescription>{t('Systems EPM reads from and writes to.')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                <Alert
                  tone="success"
                  icon={Server}
                  title={t('Delivery system')}
                  actions={
                    <>
                      <Badge tone="success" size="sm" dot>
                        {t('Connected')}
                      </Badge>
                      {can('users:manage') ? (
                        <Button asChild variant="secondary" size="sm">
                          <Link to="/settings/integration">
                            {t('Manage')}
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Link>
                        </Button>
                      ) : null}
                    </>
                  }
                >
                  {t('Projects, work packages, members and time entries')}
                </Alert>

                <Alert
                  tone="neutral"
                  icon={ExternalLink}
                  title={t('Additional integrations')}
                  actions={
                    <Badge tone="neutral" size="sm">
                      {t('Not configured')}
                    </Badge>
                  }
                >
                  {t('Identity, chat and CI connections are configured by the platform team.')}
                </Alert>
              </CardContent>
            </Card>
          ) : null}

          {section === 'security' ? <SecuritySettings /> : null}

          {section === 'api' ? (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>API</CardTitle>
                <CardDescription>{t('How EPM talks to its backend.')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                <div className="space-y-1.5">
                  <Label htmlFor="api-base">{t('EPM API base URL')}</Label>
                  <Input id="api-base" readOnly value={env.apiBaseUrl} className="font-mono text-2xs" />
                  <FieldHint>
                    {t('Configured per environment. The frontend never receives an upstream URL or token.')}
                  </FieldHint>
                </div>

                {/* No action here on purpose: there is nothing to rotate from the browser. */}
                <Alert tone="danger" icon={Lock} title={t('Tokens stay server-side')}>
                  {t(
                    'API tokens are never exposed to the frontend and cannot be viewed or rotated from this interface.',
                  )}
                </Alert>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The part of a person's identity they own.
 *
 * Name and email are theirs to change — OpenProject's own update contract
 * lists both as writable by the user themselves — so EPM offers them rather
 * than showing a disabled box. Department and timezone stay read-only above,
 * because those really are set elsewhere.
 *
 * The name is split into first and last because that is how the directory
 * stores it; showing one "display name" box would mean guessing where to cut.
 */
function ProfileForm() {
  const { user } = useAuth();
  const update = useUpdateProfile();
  const zones = useTimezones();

  // Whatever is already set stays offerable even if a tzdata change dropped it
  // from the list, so the field can always show the truth.
  const timezoneOptions = useMemo(() => {
    const known = zones.data ?? [];
    const current = user?.timezone;
    return current && !known.includes(current) ? [current, ...known] : known;
  }, [zones.data, user?.timezone]);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [timezone, setTimezone] = useState('');
  const [problem, setProblem] = useState<string>();

  // Seeded from the record once it arrives, and again if it changes elsewhere.
  useEffect(() => {
    if (!user) return;
    setFirstName(user.firstName ?? '');
    setLastName(user.lastName ?? '');
    setEmail(user.email ?? '');
    setTimezone(user.timezone ?? '');
  }, [user?.firstName, user?.lastName, user?.email, user?.timezone]);

  const dirty =
    user !== undefined &&
    (firstName !== (user.firstName ?? '') ||
      lastName !== (user.lastName ?? '') ||
      email !== (user.email ?? '') ||
      timezone !== (user.timezone ?? ''));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    if (!firstName.trim() || !lastName.trim()) {
      setProblem(t('A first and last name are required.'));
      return;
    }
    if (!email.trim()) {
      setProblem(t('An email address is required.'));
      return;
    }

    update.mutate(
      {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        ...(timezone ? { timezone } : {}),
      },
      {
        onSuccess: (updated) => toast.success(t('Saved. You are {name}.', { name: updated.name })),
        // The instance owns the rules — a duplicate address, a format it
        // rejects — so its sentence is the one worth showing.
        onError: (error) =>
          setProblem(error instanceof Error ? error.message : t('That could not be saved.')),
      },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="settings-first-name" required>
            {t('First name')}
          </Label>
          <Input
            id="settings-first-name"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            autoComplete="given-name"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="settings-last-name" required>
            {t('Last name')}
          </Label>
          <Input
            id="settings-last-name"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            autoComplete="family-name"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="settings-email" required>
            {t('Work email')}
          </Label>
          <Input
            id="settings-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
          />
          <FieldHint>
            {t('Used for invitations and notifications. Changing it does not change how you sign in.')}
          </FieldHint>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="settings-timezone">{t('Timezone')}</Label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger id="settings-timezone" aria-label={t('Timezone')} disabled={zones.isLoading}>
              <SelectValue placeholder={t('Choose a timezone')} />
            </SelectTrigger>
            <SelectContent>
              {timezoneOptions.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone.replace(/_/g, ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldHint>{t('Dates and times across EPM are shown in this zone.')}</FieldHint>
        </div>
      </div>

      {problem ? <Alert tone="danger">{problem}</Alert> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!dirty} loading={update.isPending}>
          {t('Save changes')}
        </Button>
        {dirty && !update.isPending ? (
          <span className="text-2xs text-muted-foreground">{t('Unsaved changes')}</span>
        ) : null}
      </div>
    </form>
  );
}
