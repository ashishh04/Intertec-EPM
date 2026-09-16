import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUpdateUsersSettings, useUsersSettings } from '@/hooks/useAdmin';
import type { UsersSettings, UsersSettingsInput } from '@/services/api/admin';
import { formatDateTime } from '@/lib/utils';
import { describeError } from './shared-format';

/**
 * Users settings, laid out the way OpenProject's page of the same name is:
 * default preferences, display format, deletion and user consent, each a
 * section of label/control rows, and one Save for the lot.
 *
 * The form is a copy of what the server said, edited locally; "dirty" is
 * simply "differs from the server copy", plus the one-shot consent reset,
 * which is not a stored value but an instruction sent with the save.
 */

/** Radix Select cannot carry an empty value, so the browser default has a stand-in. */
const BROWSER_DEFAULT = '__browser__';

function toInput(settings: UsersSettings): UsersSettingsInput {
  return {
    defaultLanguage: settings.defaultLanguage,
    userDefaultTimezone: settings.userDefaultTimezone,
    defaultAutoHidePopups: settings.defaultAutoHidePopups,
    userFormat: settings.userFormat,
    usersDeletableByAdmins: settings.usersDeletableByAdmins,
    usersDeletableBySelf: settings.usersDeletableBySelf,
    consentRequired: settings.consentRequired,
    consentInfo: { ...settings.consentInfo },
    resetConsentTime: false,
    consentDeclineMail: settings.consentDeclineMail,
  };
}

function sameInput(a: UsersSettingsInput, b: UsersSettingsInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function UsersSettingsPage() {
  const settings = useUsersSettings();
  const update = useUpdateUsersSettings();

  return (
    <QueryBoundary
      isLoading={settings.isLoading}
      isError={settings.isError}
      error={settings.error}
      onRetry={() => void settings.refetch()}
      errorTitle="Users settings could not be loaded"
      skeleton={<ListSkeleton rows={4} height="h-40" />}
    >
      {settings.data ? (
        <UsersSettingsForm
          settings={settings.data}
          pending={update.isPending}
          onSave={(input) =>
            update.mutate(input, {
              onSuccess: () => toast.success('Users settings saved'),
              onError: (error) =>
                toast.error('Users settings were not saved', { description: describeError(error) }),
            })
          }
        />
      ) : null}
    </QueryBoundary>
  );
}

/* ------------------------------------------------------------------------ */
/* Form                                                                      */
/* ------------------------------------------------------------------------ */

interface UsersSettingsFormProps {
  settings: UsersSettings;
  pending: boolean;
  onSave: (input: UsersSettingsInput) => void;
}

function UsersSettingsForm({ settings, pending, onSave }: UsersSettingsFormProps) {
  const server = useMemo(() => toInput(settings), [settings]);
  const [form, setForm] = useState<UsersSettingsInput>(server);

  // A fresh server copy (first load, or after a save) replaces local edits.
  useEffect(() => {
    setForm(server);
  }, [server]);

  // Every language the consent text can be written in: the instance's
  // available languages first, then any code the stored text already has.
  const consentLanguages = useMemo(() => {
    const seen = new Set<string>();
    const list: { code: string; label: string }[] = [];
    for (const language of settings.availableLanguages) {
      if (seen.has(language.code)) continue;
      seen.add(language.code);
      list.push(language);
    }
    for (const code of Object.keys(settings.consentInfo)) {
      if (seen.has(code)) continue;
      seen.add(code);
      list.push({ code, label: code });
    }
    return list;
  }, [settings.availableLanguages, settings.consentInfo]);

  const [consentLanguage, setConsentLanguage] = useState(() =>
    consentLanguages.some((language) => language.code === settings.defaultLanguage)
      ? settings.defaultLanguage
      : (consentLanguages[0]?.code ?? ''),
  );

  const dirty = !sameInput(form, server);

  const patch = (changes: Partial<UsersSettingsInput>) =>
    setForm((current) => ({ ...current, ...changes }));

  const setConsentText = (text: string) =>
    setForm((current) => ({
      ...current,
      consentInfo: { ...current.consentInfo, [consentLanguage]: text },
    }));

  return (
    <div className="space-y-4">
      <Section title="Default preferences">
        <SettingRow label="Default language" htmlFor="users-default-language">
          <Select
            value={form.defaultLanguage}
            onValueChange={(value) => patch({ defaultLanguage: value })}
            disabled={pending}
          >
            <SelectTrigger id="users-default-language" className="sm:max-w-xs">
              <SelectValue placeholder="Choose a language" />
            </SelectTrigger>
            <SelectContent>
              {settings.availableLanguages.map((language) => (
                <SelectItem key={language.code} value={language.code}>
                  {language.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow label="Users default time zone" htmlFor="users-default-timezone">
          <Select
            value={form.userDefaultTimezone ?? BROWSER_DEFAULT}
            onValueChange={(value) =>
              patch({ userDefaultTimezone: value === BROWSER_DEFAULT ? null : value })
            }
            disabled={pending}
          >
            <SelectTrigger id="users-default-timezone" className="sm:max-w-xs">
              <SelectValue placeholder="Browser default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BROWSER_DEFAULT}>Browser default</SelectItem>
              {settings.availableTimezones.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <CheckboxRow
          id="users-auto-hide"
          label="Auto-hide success notifications"
          checked={form.defaultAutoHidePopups}
          disabled={pending}
          onCheckedChange={(checked) => patch({ defaultAutoHidePopups: checked })}
        />
      </Section>

      <Section title="Display format">
        <SettingRow label="Users name format" htmlFor="users-name-format">
          <Select
            value={form.userFormat}
            onValueChange={(value) => patch({ userFormat: value })}
            disabled={pending}
          >
            <SelectTrigger id="users-name-format" className="sm:max-w-xs">
              <SelectValue placeholder="Choose a format" />
            </SelectTrigger>
            <SelectContent>
              {settings.userFormatOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </Section>

      <Section title="Deletion">
        <CheckboxRow
          id="users-deletable-by-admins"
          label="User accounts deletable by admins"
          checked={form.usersDeletableByAdmins}
          disabled={pending}
          onCheckedChange={(checked) => patch({ usersDeletableByAdmins: checked })}
        />
        <CheckboxRow
          id="users-deletable-by-self"
          label="Users allowed to delete their accounts"
          checked={form.usersDeletableBySelf}
          disabled={pending}
          onCheckedChange={(checked) => patch({ usersDeletableBySelf: checked })}
        />
      </Section>

      <Section title="User consent">
        <CheckboxRow
          id="users-consent-required"
          label="Consent required"
          checked={form.consentRequired}
          disabled={pending}
          onCheckedChange={(checked) => patch({ consentRequired: checked })}
        />

        <SettingRow label="Consent information text" htmlFor="users-consent-text">
          <div className="space-y-2">
            <Select value={consentLanguage} onValueChange={setConsentLanguage} disabled={pending}>
              <SelectTrigger className="sm:max-w-xs" aria-label="Consent text language">
                <SelectValue placeholder="Choose a language" />
              </SelectTrigger>
              <SelectContent>
                {consentLanguages.map((language) => (
                  <SelectItem key={language.code} value={language.code}>
                    {language.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              id="users-consent-text"
              value={form.consentInfo[consentLanguage] ?? ''}
              onChange={(event) => setConsentText(event.target.value)}
              disabled={pending || !consentLanguage}
              rows={10}
              spellCheck={false}
              className="min-h-40 font-mono text-xs"
              aria-describedby="users-consent-text-hint"
            />
            <FieldHint id="users-consent-text-hint">
              Written in markdown. Shown to every user who has to consent, in their language.
            </FieldHint>
          </div>
        </SettingRow>

        <SettingRow label="Consent time" htmlFor="users-reset-consent">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Checkbox
                id="users-reset-consent"
                checked={form.resetConsentTime}
                disabled={pending}
                onCheckedChange={(checked) => patch({ resetConsentTime: checked === true })}
                aria-describedby="users-reset-consent-hint"
              />
              <Label htmlFor="users-reset-consent" className="font-normal">
                Force users to consent again
              </Label>
            </div>
            <FieldHint id="users-reset-consent-hint">
              Check this box to force users to consent again. Enable when you have changed the
              legal aspect of the consent information above.
            </FieldHint>
            <p className="text-2xs text-muted-foreground">
              Last update of consent:{' '}
              <span className="font-mono">
                {settings.consentTime ? formatDateTime(settings.consentTime) : 'Never'}
              </span>
            </p>
          </div>
        </SettingRow>

        <SettingRow label="Consent contact mail address" htmlFor="users-consent-mail">
          <div className="space-y-1.5">
            <Input
              id="users-consent-mail"
              type="email"
              value={form.consentDeclineMail}
              onChange={(event) => patch({ consentDeclineMail: event.target.value })}
              disabled={pending}
              className="sm:max-w-xs"
              aria-describedby="users-consent-mail-hint"
            />
            <FieldHint id="users-consent-mail-hint">
              Define the mail address that users can reach a data controller to perform data
              change or removal requests.
            </FieldHint>
          </div>
        </SettingRow>
      </Section>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => onSave(form)} disabled={!dirty} loading={pending}>
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setForm(server)}
          disabled={!dirty || pending}
        >
          Reset
        </Button>
        {dirty ? (
          <span className="text-2xs text-muted-foreground" aria-live="polite">
            Unsaved changes
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Layout pieces                                                             */
/* ------------------------------------------------------------------------ */

/** One card per section, its title on the compact header above its rows. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <div className="divide-y divide-border">{children}</div>
    </Card>
  );
}

/** Label on the left, control on the right; stacked on narrow screens. */
function SettingRow({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-4">
      <Label htmlFor={htmlFor} className="text-xs sm:pt-2.5">
        {label}
      </Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A yes/no setting: the box sits in the control column, level with its label. */
function CheckboxRow({
  id,
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-4">
      <Label htmlFor={id} className="text-xs sm:pt-0.5">
        {label}
      </Label>
      <div className="flex items-center">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onCheckedChange(value === true)}
        />
      </div>
    </div>
  );
}
