import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowRight,
  ExternalLink,
  Lock,
  RotateCcw,
  Server,
  ShieldCheck,
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
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SETTINGS_SECTIONS, isAdministrator, type SettingsSectionId } from '@/config/navigation';
import { useAuth } from '@/providers/AuthProvider';
import { usePreferences, type Preferences } from '@/hooks/usePreferences';
import { APP_NAME, ORG_NAME, env } from '@/config/env';
import { cn } from '@/lib/utils';

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
        title="Settings"
        description={`Configure how ${APP_NAME} works for you and your workspace.`}
      />

      <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
        {/* Section navigation */}
        <nav aria-label="Settings sections" className="lg:sticky lg:top-20 lg:self-start">
          <ul className="epm-scroll flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {visibleSections.map((item, index) => (
              <Fragment key={item.id}>
                {administrator && index === 0 ? (
                  <li className="hidden shrink-0 lg:block">
                    <p className="epm-eyebrow px-2.5 pb-1">Account</p>
                  </li>
                ) : null}
                {item.group === 'administration' &&
                visibleSections[index - 1]?.group !== 'administration' ? (
                  <li className="hidden shrink-0 lg:block">
                    <p className="epm-eyebrow mt-3 px-2.5 pb-1">Administration</p>
                  </li>
                ) : null}
                <li className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setSection(item.id)}
                    aria-current={section === item.id ? 'page' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors',
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
                <CardTitle>Profile</CardTitle>
                <CardDescription>Your identity across the platform.</CardDescription>
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
                  <Label htmlFor="settings-department">Department</Label>
                  <Input id="settings-department" defaultValue={user?.department} readOnly />
                  <FieldHint>Set by an administrator on the Employees page.</FieldHint>
                </div>

                <Button asChild variant="secondary" size="sm">
                  <Link to="/profile">
                    Open profile
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {section === 'appearance' ? (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>Appearance</CardTitle>
                <CardDescription>How EPM looks on this device.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {/* No theme picker: EPM follows the Intertec brand, which is a
                    single light identity. */}
                <div className="divide-y divide-border">
                  <ToggleRow
                    id="dense-tables"
                    label="Compact tables"
                    hint="Reduce row height in work package tables."
                    checked={preferences.appearance.compactTables}
                    onCheckedChange={(checked) => update('appearance', 'compactTables', checked)}
                  />
                  <ToggleRow
                    id="reduced-motion"
                    label="Reduce motion"
                    hint="Minimise transitions and animated chart entrances."
                    checked={preferences.appearance.reduceMotion}
                    onCheckedChange={(checked) => update('appearance', 'reduceMotion', checked)}
                  />
                  <ToggleRow
                    id="show-avatars"
                    label="Show avatars"
                    hint="Faces beside names in lists and boards."
                    checked={preferences.appearance.showAvatars}
                    onCheckedChange={(checked) => update('appearance', 'showAvatars', checked)}
                  />
                </div>
              </CardContent>
            </Card>
          ) : null}

          {section === 'notifications' ? (
            <>
              <Card>
                <CardHeader variant="compact">
                  <CardTitle>In-app</CardTitle>
                  <CardDescription>What appears in your notifications feed.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {NOTIFICATION_ROWS.map((row) => (
                      <ToggleRow
                        key={row.key}
                        id={`notify-${row.key}`}
                        label={row.label}
                        hint={row.hint}
                        checked={preferences.notifications[row.key]}
                        onCheckedChange={(checked) => update('notifications', row.key, checked)}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Email has its own card and its own master switch: it reaches
                  the person while EPM is closed, so opting out of all of it
                  has to be one movement rather than five. */}
              <Card>
                <CardHeader variant="compact">
                  <CardTitle>Email</CardTitle>
                  <CardDescription>
                    What EPM sends to {user?.email ? user.email : 'your work email'}.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    <ToggleRow
                      id="email-enabled"
                      label="Send me email"
                      hint="Off means no email of any kind."
                      checked={preferences.email.enabled}
                      onCheckedChange={(checked) => update('email', 'enabled', checked)}
                    />
                    {EMAIL_ROWS.map((row) => (
                      <ToggleRow
                        key={row.key}
                        id={`email-${row.key}`}
                        label={row.label}
                        hint={row.hint}
                        checked={preferences.email[row.key]}
                        disabled={!preferences.email.enabled}
                        onCheckedChange={(checked) => update('email', row.key, checked)}
                      />
                    ))}
                    <div className="px-4 py-2.5">
                      <FieldHint>
                        One summary a day, at 06:00 UTC, for everything not sent immediately.
                      </FieldHint>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : null}

          {section === 'workspace' ? (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>Workspace</CardTitle>
                <CardDescription>Defaults applied across {ORG_NAME}.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                <FactList
                  facts={[
                    { label: 'Organisation', value: ORG_NAME, mono: false },
                    { label: 'Application', value: APP_NAME, mono: false },
                    {
                      label: 'Environment',
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
                    <Label htmlFor="workspace-landing">Default landing page</Label>
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
                        <SelectItem value="dashboard">Overview</SelectItem>
                        <SelectItem value="my-work">My Work</SelectItem>
                        <SelectItem value="projects">Projects</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="workspace-week">Week starts on</Label>
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
                        <SelectItem value="monday">Monday</SelectItem>
                        <SelectItem value="sunday">Sunday</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <FieldHint>{isSaving ? 'Saving…' : 'Changes are saved as you make them.'}</FieldHint>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      // The failure toast comes from the hook; only the
                      // success is worth saying here.
                      reset().then(
                        () => toast.success('Preferences reset to defaults'),
                        () => undefined,
                      )
                    }
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reset to defaults
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
                    ? 'Project types, statuses, custom fields and work package types.'
                    : 'Groups, memberships and role assignments.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                <FactList
                  facts={(section === 'projects'
                    ? ['Work package types', 'Statuses and workflows', 'Custom fields', 'Versions']
                    : ['Groups', 'Roles and permissions', 'Memberships', 'Directory sync']
                  ).map((item) => ({
                    label: item,
                    mono: false,
                    value: (
                      <Badge tone="neutral" size="sm">
                        <Lock className="h-2.5 w-2.5" aria-hidden />
                        Managed
                      </Badge>
                    ),
                  }))}
                />
                <FieldHint>
                  An administrator manages these in the upstream system. EPM reflects the values
                  after the next synchronisation.
                </FieldHint>
              </CardContent>
            </Card>
          ) : null}

          {section === 'integrations' ? (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>Integrations</CardTitle>
                <CardDescription>Systems EPM reads from and writes to.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                <Alert
                  tone="success"
                  icon={Server}
                  title="Delivery system"
                  actions={
                    <>
                      <Badge tone="success" size="sm" dot>
                        Connected
                      </Badge>
                      {can('users:manage') ? (
                        <Button asChild variant="secondary" size="sm">
                          <Link to="/settings/integration">
                            Manage
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Link>
                        </Button>
                      ) : null}
                    </>
                  }
                >
                  Projects, work packages, members and time entries
                </Alert>

                <Alert
                  tone="neutral"
                  icon={ExternalLink}
                  title="Additional integrations"
                  actions={
                    <Badge tone="neutral" size="sm">
                      Not configured
                    </Badge>
                  }
                >
                  Identity, chat and CI connections are configured by the platform team.
                </Alert>
              </CardContent>
            </Card>
          ) : null}

          {section === 'security' ? (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>Security</CardTitle>
                <CardDescription>Authentication and session policy.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                <Alert tone="neutral" icon={ShieldCheck}>
                  Authentication, authorisation and API credentials are handled entirely by the
                  EPM backend. No tokens or secrets are ever stored in the browser.
                </Alert>

                <FactList
                  facts={[
                    { label: 'Single sign-on', value: 'Microsoft Entra ID' },
                    { label: 'Multi-factor authentication', value: 'Enforced by policy' },
                    { label: 'Session lifetime', value: '8 hours' },
                    { label: 'API credentials', value: 'Server-side only' },
                  ]}
                />
              </CardContent>
            </Card>
          ) : null}

          {section === 'api' ? (
            <Card>
              <CardHeader variant="compact">
                <CardTitle>API</CardTitle>
                <CardDescription>How EPM talks to its backend.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                <div className="space-y-1.5">
                  <Label htmlFor="api-base">EPM API base URL</Label>
                  <Input id="api-base" readOnly value={env.apiBaseUrl} className="font-mono text-2xs" />
                  <FieldHint>
                    Configured per environment. The frontend never receives an upstream URL or token.
                  </FieldHint>
                </div>

                {/* No action here on purpose: there is nothing to rotate from the browser. */}
                <Alert tone="danger" icon={Lock} title="Tokens stay server-side">
                  API tokens are never exposed to the frontend and cannot be viewed or rotated from
                  this interface.
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
 * Copy for each notification switch, keyed by the preference it drives. The
 * Profile page renders a subset of the same keys, so the two never disagree.
 */
const NOTIFICATION_ROWS: {
  key: keyof Preferences['notifications'];
  label: string;
  hint: string;
}[] = [
  { key: 'mentions', label: 'Mentions', hint: 'When someone mentions you in a comment.' },
  { key: 'assigned', label: 'Assignments', hint: 'When work is assigned to you.' },
  { key: 'dueReminders', label: 'Deadline reminders', hint: 'Two days before a due date.' },
  {
    key: 'statusChanges',
    label: 'Project updates',
    hint: 'Status and health changes on your projects.',
  },
  { key: 'digest', label: 'Daily digest', hint: 'A morning summary, in your notifications feed.' },
];

/**
 * The per-type email switches. The master switch above them is separate, and
 * every one of these is inert while it is off.
 */
const EMAIL_ROWS: {
  key: Exclude<keyof Preferences['email'], 'enabled'>;
  label: string;
  hint: string;
}[] = [
  { key: 'assigned', label: 'Assignments', hint: 'When work is assigned to you.' },
  { key: 'mentions', label: 'Mentions', hint: 'When someone mentions you in a comment.' },
  {
    key: 'membership',
    label: 'Project access',
    hint: 'When you are added to a project.',
  },
  {
    key: 'updates',
    label: 'Updates to my work',
    hint: 'Status and field changes on work you are assigned to or watch.',
  },
  {
    key: 'dueReminders',
    label: 'Deadline reminders',
    // The window is configured on the backend, so the hint describes the shape
    // rather than a number this page cannot know.
    hint: 'A daily list of anything overdue or falling due shortly.',
  },
  { key: 'digest', label: 'Daily digest', hint: 'A morning summary of what needs attention.' },
];

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
      setProblem('A first and last name are required.');
      return;
    }
    if (!email.trim()) {
      setProblem('An email address is required.');
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
        onSuccess: (updated) => toast.success(`Saved. You are ${updated.name}.`),
        // The instance owns the rules — a duplicate address, a format it
        // rejects — so its sentence is the one worth showing.
        onError: (error) =>
          setProblem(error instanceof Error ? error.message : 'That could not be saved.'),
      },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="settings-first-name" required>
            First name
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
            Last name
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
            Work email
          </Label>
          <Input
            id="settings-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
          />
          <FieldHint>
            Used for invitations and notifications. Changing it does not change how you sign in.
          </FieldHint>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="settings-timezone">Timezone</Label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger id="settings-timezone" aria-label="Timezone" disabled={zones.isLoading}>
              <SelectValue placeholder="Choose a timezone" />
            </SelectTrigger>
            <SelectContent>
              {timezoneOptions.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone.replace(/_/g, ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldHint>Dates and times across EPM are shown in this zone.</FieldHint>
        </div>
      </div>

      {problem ? <Alert tone="danger">{problem}</Alert> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!dirty} loading={update.isPending}>
          Save changes
        </Button>
        {dirty && !update.isPending ? (
          <span className="text-2xs text-muted-foreground">Unsaved changes</span>
        ) : null}
      </div>
    </form>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  /** Inert, and reads as such, because a switch above it is off. */
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className={cn('min-w-0 space-y-0.5', disabled && 'opacity-60')}>
        <Label htmlFor={id}>{label}</Label>
        <FieldHint>{hint}</FieldHint>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}
