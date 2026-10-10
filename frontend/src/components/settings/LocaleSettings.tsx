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
import { LANGUAGES, msg, t } from '@/lib/i18n';
import { formatLongDate, formatShortDate } from '@/lib/utils';

/**
 * Language and regional formatting.
 *
 * The language is EPM's and OpenProject's at once: EPM's screens, messages and
 * email follow it (BR-605), and it is also written to the OpenProject account so
 * the delivery system's own screens and mail agree. EPM switches first and does
 * not wait on OpenProject — an instance that has not enabled a language refuses
 * it, and that must not keep EPM in English. Date format, calendar, digits and
 * clock are EPM's alone: they only affect how this interface writes a value.
 */

const DATE_FORMATS: { value: Preferences['locale']['dateFormat']; label: string }[] = [
  { value: 'system', label: msg('Follow this device') },
  { value: 'iso', label: '2026-09-29' },
  { value: 'dmy', label: '29/09/2026' },
  { value: 'mdy', label: '09/29/2026' },
];

const CALENDARS: { value: Preferences['locale']['calendar']; label: string }[] = [
  { value: 'gregory', label: msg('Gregorian') },
  { value: 'islamic-umalqura', label: msg('Hijri (Umm al-Qura)') },
];

const NUMERALS: { value: Preferences['locale']['numerals']; label: string }[] = [
  { value: 'latn', label: msg('Western (0-9)') },
  { value: 'arab', label: msg('Arabic-Indic (٠-٩)') },
];

/** Follows the instance default rather than claiming a language of its own. */
const INSTANCE_DEFAULT = '__instance__';

export function LocaleSettings() {
  const { user } = useAuth();
  const { preferences, update } = usePreferences();
  const updateProfile = useUpdateProfile();

  // EPM's own setting first: it is what the screens follow. The account's value
  // fills in for somebody who chose a language before EPM had any but English.
  const language = preferences.locale.language || user?.language || '';

  const setLanguage = (next: string) => {
    const code = next === INSTANCE_DEFAULT ? '' : next;
    update('locale', 'language', code);

    updateProfile.mutate(
      { language: code },
      {
        onError: (error) =>
          toast.warning(t('EPM has switched; the delivery system kept its own language'), {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('Language and region')}</CardTitle>
        <CardDescription>{t('How EPM reads and writes dates, times and text.')}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border">
          <FieldRow
            label={t('Language')}
            hint={t('EPM’s screens, messages and email, and the delivery system’s own screens. Arabic reads right to left.')}
            htmlFor="locale-language"
          >
            <Select value={language || INSTANCE_DEFAULT} onValueChange={setLanguage}>
              <SelectTrigger id="locale-language" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INSTANCE_DEFAULT}>{t('Instance default')}</SelectItem>
                {LANGUAGES.map((option) => (
                  // Each language is named in itself, so it can be found by
                  // someone who cannot read the one currently shown.
                  <SelectItem key={option.value} value={option.value}>
                    <span lang={option.value}>{option.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

          <FieldRow
            label={t('Date format')}
            hint={t('Dates read as {short} — for example {long}.', {
              short: formatShortDate('2026-09-29'),
              long: formatLongDate('2026-09-29'),
            })}
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
                    {t(option.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

          <FieldRow
            label={t('Calendar')}
            hint={t('How dates are shown. They are stored and exchanged as Gregorian dates either way.')}
            htmlFor="locale-calendar"
          >
            <Select
              value={preferences.locale.calendar}
              onValueChange={(value) => update('locale', 'calendar', value as Preferences['locale']['calendar'])}
            >
              <SelectTrigger id="locale-calendar" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CALENDARS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

          <FieldRow
            label={t('Digits')}
            hint={t('Used in figures, dates and times.')}
            htmlFor="locale-numerals"
          >
            <Select
              value={preferences.locale.numerals}
              onValueChange={(value) => update('locale', 'numerals', value as Preferences['locale']['numerals'])}
            >
              <SelectTrigger id="locale-numerals" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NUMERALS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

          <FieldRow label={t('Clock')} hint={t('Applies wherever a time of day is shown.')} htmlFor="locale-clock">
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
                <SelectItem value="24h">{t('24-hour')}</SelectItem>
                <SelectItem value="12h">{t('12-hour')}</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          <FieldRow
            label={t('Week starts on')}
            hint={t('Used by the calendar, the timesheet and every weekly total.')}
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
                <SelectItem value="monday">{t('Monday')}</SelectItem>
                <SelectItem value="sunday">{t('Sunday')}</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          <div className="px-4 py-2.5">
            <FieldHint>
              {t(
                'Your timezone is on the Profile section. It decides what a date means, where these decide how one is written.',
              )}
            </FieldHint>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
