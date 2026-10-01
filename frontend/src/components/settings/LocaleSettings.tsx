import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHint } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldRow } from './SettingsRows';
import { usePreferences, type Preferences } from '@/hooks/usePreferences';
import { useUpdateProfile } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import { formatLongDate, formatShortDate } from '@/lib/utils';

/**
 * Language and regional formatting.
 *
 * Two different owners on one card, which is why it says so. Language is
 * OpenProject's — it is an attribute of the account, the instance decides which
 * ones exist, and it governs the language of anything the instance itself sends.
 * Date format and clock are EPM's: they only affect how this interface writes a
 * value, so there is nothing upstream to ask.
 */

/**
 * The languages offered.
 *
 * OpenProject publishes no list of its available locales over API v3, so this is
 * the set EPM's own interface is written for. Choosing one writes it to the
 * account, and the instance refuses a code it does not have — which is the
 * check, rather than a list here pretending to be one.
 */
const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'ar', label: 'العربية' },
];

const DATE_FORMATS: { value: Preferences['locale']['dateFormat']; label: string }[] = [
  { value: 'system', label: 'Follow this device' },
  { value: 'iso', label: '2026-09-29' },
  { value: 'dmy', label: '29/09/2026' },
  { value: 'mdy', label: '09/29/2026' },
];

/** Follows the instance default rather than claiming a language of its own. */
const INSTANCE_DEFAULT = '__instance__';

export function LocaleSettings() {
  const { user } = useAuth();
  const { preferences, update } = usePreferences();
  const updateProfile = useUpdateProfile();

  // The account is authoritative for language, so the control reflects what is
  // on the account and the preference copy follows it. Showing the preference
  // would let the two disagree after a write the instance refused.
  const language = user?.language || preferences.locale.language || '';

  const setLanguage = (next: string) => {
    const code = next === INSTANCE_DEFAULT ? '' : next;

    // Written to the account first. The preference copy exists so the email
    // pipeline can read a language without a session, and is only worth updating
    // once the instance has accepted the value.
    updateProfile.mutate(
      { language: code },
      {
        onSuccess: () => {
          update('locale', 'language', code);
          toast.success('Language saved');
        },
        onError: (error) =>
          toast.error('That language could not be saved', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>Language and region</CardTitle>
        <CardDescription>How EPM reads and writes dates, times and text.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border">
          <FieldRow
            label="Language"
            hint="Set on your account, so anything the delivery system emails you uses it too."
            htmlFor="locale-language"
          >
            <Select
              value={language || INSTANCE_DEFAULT}
              disabled={updateProfile.isPending}
              onValueChange={setLanguage}
            >
              <SelectTrigger id="locale-language" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INSTANCE_DEFAULT}>Instance default</SelectItem>
                {LANGUAGES.map((option) => (
                  <SelectItem key={option.code} value={option.code}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

          <FieldRow
            label="Date format"
            hint={`Dates read as ${formatShortDate('2026-09-29')} — for example ${formatLongDate('2026-09-29')}.`}
            htmlFor="locale-date-format"
          >
            <Select
              value={preferences.locale.dateFormat}
              onValueChange={(value) =>
                update('locale', 'dateFormat', value as Preferences['locale']['dateFormat'])
              }
            >
              <SelectTrigger id="locale-date-format" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_FORMATS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

          <FieldRow label="Clock" hint="Applies wherever a time of day is shown." htmlFor="locale-clock">
            <Select
              value={preferences.workweek.timeFormat}
              onValueChange={(value) =>
                update('workweek', 'timeFormat', value as Preferences['workweek']['timeFormat'])
              }
            >
              <SelectTrigger id="locale-clock" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24h">24-hour</SelectItem>
                <SelectItem value="12h">12-hour</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          <FieldRow
            label="Week starts on"
            hint="Used by the calendar, the timesheet and every weekly total."
            htmlFor="locale-week-start"
          >
            <Select
              value={preferences.workweek.startOfWeek}
              onValueChange={(value) =>
                update('workweek', 'startOfWeek', value as Preferences['workweek']['startOfWeek'])
              }
            >
              <SelectTrigger id="locale-week-start" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="monday">Monday</SelectItem>
                <SelectItem value="sunday">Sunday</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          <div className="px-4 py-2.5">
            <FieldHint>
              Your timezone is on the Profile section. It decides what a date means, where these
              decide how one is written.
            </FieldHint>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
