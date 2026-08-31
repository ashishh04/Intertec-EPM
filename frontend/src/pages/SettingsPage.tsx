import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowRight,
  ExternalLink,
  Lock,
  Monitor,
  Moon,
  Server,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { NexusLogo } from '@/components/common/NexusLogo';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label, FieldHint } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SETTINGS_SECTIONS, type SettingsSectionId } from '@/config/navigation';
import { useAuth } from '@/providers/AuthProvider';
import { useTheme, type ThemeSetting } from '@/providers/ThemeProvider';
import { APP_NAME, ORG_NAME, env } from '@/config/env';
import { cn } from '@/lib/utils';

/**
 * Enterprise settings. Sections owned by OpenProject are marked and read-only
 * here, so it is always clear which system is authoritative for a setting.
 */
export default function SettingsPage() {
  const [section, setSection] = useState<SettingsSectionId>('profile');
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();

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
          <ul className="nexus-scroll flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {SETTINGS_SECTIONS.map((item) => (
              <li key={item.id} className="shrink-0">
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
                  {item.openProject ? (
                    <Server className="ml-auto h-3 w-3 shrink-0 opacity-60" aria-hidden />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          <p className="mt-3 hidden items-start gap-1.5 px-2.5 text-2xs text-muted-foreground lg:flex">
            <Server className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            Managed by OpenProject
          </p>
        </nav>

        <div className="min-w-0 space-y-4">
          {active.openProject ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning-soft p-3">
              <Server className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <div>
                <p className="text-xs font-medium text-foreground">
                  These settings are owned by OpenProject
                </p>
                <p className="mt-0.5 text-2xs text-muted-foreground">
                  {APP_NAME} reads them through the Nexus backend and shows them here for context.
                  Changes are made in the upstream system by an administrator.
                </p>
              </div>
            </div>
          ) : null}

          {section === 'profile' ? (
            <Card>
              <CardHeader className="border-b border-border">
                <CardTitle>Profile</CardTitle>
                <CardDescription>Your identity across the platform.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                <div className="flex items-center gap-3">
                  <UserAvatar user={user} size="lg" />
                  <div>
                    <p className="text-xs font-medium">{user?.name}</p>
                    <p className="text-2xs text-muted-foreground">{user?.role}</p>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="settings-name">Display name</Label>
                    <Input id="settings-name" defaultValue={user?.name} readOnly />
                    <FieldHint>Synchronised from the organisation directory.</FieldHint>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="settings-email">Work email</Label>
                    <Input id="settings-email" defaultValue={user?.email} readOnly />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="settings-department">Department</Label>
                    <Input id="settings-department" defaultValue={user?.department} readOnly />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="settings-timezone">Timezone</Label>
                    <Input id="settings-timezone" defaultValue={user?.timezone} readOnly />
                  </div>
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
              <CardHeader className="border-b border-border">
                <CardTitle>Appearance</CardTitle>
                <CardDescription>How Nexus looks on this device.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5 pt-4">
                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium">Theme</legend>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(
                      [
                        { value: 'light', label: 'Light', icon: Sun },
                        { value: 'dark', label: 'Dark', icon: Moon },
                        { value: 'system', label: 'System', icon: Monitor },
                      ] as { value: ThemeSetting; label: string; icon: typeof Sun }[]
                    ).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setTheme(option.value)}
                        aria-pressed={theme === option.value}
                        className={cn(
                          'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-medium transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          theme === option.value
                            ? 'border-primary/40 bg-primary-soft text-primary'
                            : 'border-border bg-surface text-muted-foreground hover:border-primary/25 hover:text-foreground',
                        )}
                      >
                        <option.icon className="h-4 w-4" aria-hidden />
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <FieldHint>Your choice is remembered on this device.</FieldHint>
                </fieldset>

                <Separator />

                <ToggleRow
                  id="dense-tables"
                  label="Compact tables"
                  hint="Reduce row height in work package tables."
                  defaultChecked
                />
                <ToggleRow
                  id="reduced-motion"
                  label="Reduce motion"
                  hint="Minimise transitions and animated chart entrances."
                />
              </CardContent>
            </Card>
          ) : null}

          {section === 'notifications' ? (
            <Card>
              <CardHeader className="border-b border-border">
                <CardTitle>Notifications</CardTitle>
                <CardDescription>What Nexus tells you about, and where.</CardDescription>
              </CardHeader>
              <CardContent className="divide-y divide-border pt-0">
                <ToggleRow id="notify-mentions" label="Mentions" hint="When someone mentions you in a comment." defaultChecked />
                <ToggleRow id="notify-assign" label="Assignments" hint="When work is assigned to you." defaultChecked />
                <ToggleRow id="notify-deadline" label="Deadline reminders" hint="Two days before a due date." defaultChecked />
                <ToggleRow id="notify-project" label="Project updates" hint="Status and health changes on your projects." />
                <ToggleRow id="notify-digest" label="Daily digest email" hint="A morning summary of what needs attention." />
              </CardContent>
            </Card>
          ) : null}

          {section === 'workspace' ? (
            <Card>
              <CardHeader className="border-b border-border">
                <CardTitle>Workspace</CardTitle>
                <CardDescription>Defaults applied across {ORG_NAME}.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                  <NexusLogo variant="full" showDescriptor />
                  <Badge tone="highlight" size="sm" className="ml-auto capitalize">
                    {env.appEnv}
                  </Badge>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="workspace-landing">Default landing page</Label>
                    <Select defaultValue="dashboard">
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
                    <Select defaultValue="monday">
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

                <Button size="sm" onClick={() => toast.success('Changes saved')}>
                  Save changes
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {section === 'projects' || section === 'teams' ? (
            <Card>
              <CardHeader className="border-b border-border">
                <CardTitle>{active.label}</CardTitle>
                <CardDescription>
                  {section === 'projects'
                    ? 'Project types, statuses, custom fields and work package types.'
                    : 'Groups, memberships and role assignments.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-4">
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {(section === 'projects'
                    ? ['Work package types', 'Statuses and workflows', 'Custom fields', 'Versions']
                    : ['Groups', 'Roles and permissions', 'Memberships', 'Directory sync']
                  ).map((item) => (
                    <li key={item} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <span className="text-xs">{item}</span>
                      <Badge tone="neutral" size="sm">
                        <Lock className="h-2.5 w-2.5" aria-hidden />
                        OpenProject
                      </Badge>
                    </li>
                  ))}
                </ul>
                <p className="text-2xs text-muted-foreground">
                  An administrator manages these in the upstream system. Nexus reflects the values
                  after the next synchronisation.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {section === 'integrations' ? (
            <Card>
              <CardHeader className="border-b border-border">
                <CardTitle>Integrations</CardTitle>
                <CardDescription>Systems Nexus reads from and writes to.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-4">
                <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-lg bg-success-soft text-success"
                    aria-hidden
                  >
                    <Server className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">OpenProject</p>
                    <p className="text-2xs text-muted-foreground">
                      Projects, work packages, members and time entries
                    </p>
                  </div>
                  <Badge tone="success" size="sm" dot>
                    Connected
                  </Badge>
                  <Button asChild variant="secondary" size="sm">
                    <Link to="/settings/integration">
                      Manage
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>

                <div className="flex items-center gap-3 rounded-lg border border-dashed border-border p-3">
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                    aria-hidden
                  >
                    <ExternalLink className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">Additional integrations</p>
                    <p className="text-2xs text-muted-foreground">
                      Identity, chat and CI connections are configured by the platform team.
                    </p>
                  </div>
                  <Badge tone="neutral" size="sm">
                    Not configured
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {section === 'security' ? (
            <Card>
              <CardHeader className="border-b border-border">
                <CardTitle>Security</CardTitle>
                <CardDescription>Authentication and session policy.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/60 p-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                  <p className="text-2xs text-muted-foreground">
                    Authentication, authorisation and API credentials are handled entirely by the
                    Nexus backend. No tokens or secrets are ever stored in the browser.
                  </p>
                </div>

                <ul className="divide-y divide-border rounded-lg border border-border">
                  {[
                    { label: 'Single sign-on', value: 'Microsoft Entra ID' },
                    { label: 'Multi-factor authentication', value: 'Enforced by policy' },
                    { label: 'Session lifetime', value: '8 hours' },
                    { label: 'API credentials', value: 'Server-side only' },
                  ].map((item) => (
                    <li key={item.label} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <span className="text-xs">{item.label}</span>
                      <span className="font-mono text-2xs text-muted-foreground">{item.value}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {section === 'api' ? (
            <Card>
              <CardHeader className="border-b border-border">
                <CardTitle>API</CardTitle>
                <CardDescription>How Nexus talks to its backend.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="api-base">Nexus API base URL</Label>
                  <Input id="api-base" readOnly value={env.apiBaseUrl} className="font-mono text-2xs" />
                  <FieldHint>
                    Configured per environment. The frontend never receives an OpenProject URL or token.
                  </FieldHint>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="api-source">Data source</Label>
                  <Input id="api-source" readOnly value={env.dataSource} className="font-mono text-2xs" />
                  <FieldHint>
                    {env.dataSource === 'mock'
                      ? 'Serving bundled demo data. Set VITE_DATA_SOURCE=api to use the live backend.'
                      : 'Serving live data from the Nexus backend.'}
                  </FieldHint>
                </div>

                <div className="flex items-start gap-2.5 rounded-lg border border-danger/20 bg-danger-soft p-3">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
                  <p className="text-2xs text-muted-foreground">
                    API tokens are never exposed to the frontend and cannot be viewed or rotated from
                    this interface.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  defaultChecked,
}: {
  id: string;
  label: string;
  hint: string;
  defaultChecked?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3.5">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <p className="mt-0.5 text-2xs text-muted-foreground">{hint}</p>
      </div>
      <Switch
        id={id}
        defaultChecked={defaultChecked}
        onCheckedChange={(checked) =>
          toast.success('Preference saved', {
            description: `${label} ${checked ? 'enabled' : 'disabled'}.`,
          })
        }
      />
    </div>
  );
}
