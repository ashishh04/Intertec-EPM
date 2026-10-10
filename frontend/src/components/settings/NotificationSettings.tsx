import { BellOff, Clock } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldRow, ToggleRow, WeekdayPicker, hourOptions } from './SettingsRows';
import { usePreferences, type Preferences } from '@/hooks/usePreferences';
import { useAuth } from '@/providers/AuthProvider';
import { formatLongDate } from '@/lib/utils';
import { t } from '@/lib/i18n';

/**
 * Notification settings.
 *
 * Three cards, in the order the questions are actually asked: what do I want to
 * hear about, when may it reach me by email, and is there a period when nothing
 * should. Splitting them that way is what makes the pause control findable —
 * folded in among twelve switches it reads as a thirteenth.
 *
 * Every switch here has an effect. The in-app ones filter the feed on read, the
 * email ones gate the outbox at the point a row would be written, and the pause
 * window stops mail being queued at all. Nothing on this page is decorative.
 */

/** Keys of `T` whose value is a boolean, so a switch row cannot be given an object. */
type BooleanKeys<T> = { [K in keyof T]: T[K] extends boolean ? K : never }[keyof T];

type NotificationSwitch = BooleanKeys<Preferences['notifications']>;
type EmailSwitch = Exclude<BooleanKeys<Preferences['email']>, 'enabled'>;

/**
 * Copy for each in-app switch, keyed by the preference it drives.
 *
 * Ordered narrowest first: work aimed directly at this person, then work they
 * are merely near, then the scheduled summaries. Somebody turning things off
 * generally works from the bottom up.
 */
const NOTIFICATION_ROWS: { key: NotificationSwitch; label: string; hint: string }[] = [
  { key: 'mentions', get label() { return t('Mentioned'); }, get hint() { return t('When someone mentions you in a comment.'); } },
  { key: 'assigned', get label() { return t('Assignee'); }, get hint() { return t('When work is assigned to you.'); } },
  {
    key: 'accountable',
    get label() { return t('Accountable'); },
    get hint() { return t('When you are the one answering for the work, rather than doing it.'); },
  },
  { key: 'watcher', get label() { return t('Watcher'); }, get hint() { return t('Changes to work you follow without owning.'); } },
  {
    key: 'shared',
    get label() { return t('Shared with me'); },
    get hint() { return t('When work or a project is shared with you directly.'); },
  },
  {
    key: 'participating',
    get label() { return t('Other activity'); },
    get hint() { return t('Changes to work you raised or have commented on.'); },
  },
  {
    key: 'dateAlerts',
    get label() { return t('Date alerts'); },
    get hint() { return t('When a start or finish date on that work is approaching.'); },
  },
  { key: 'dueReminders', get label() { return t('Deadline reminders'); }, get hint() { return t('Shortly before a due date.'); } },
  {
    key: 'statusChanges',
    get label() { return t('Project updates'); },
    get hint() { return t('Status, health and staffing changes on your projects.'); },
  },
  { key: 'digest', get label() { return t('Daily digest'); }, get hint() { return t('A morning summary, in your notifications feed.'); } },
];

/** The per-type email switches. The master switch above them is separate. */
const EMAIL_ROWS: { key: EmailSwitch; label: string; hint: string }[] = [
  { key: 'assigned', get label() { return t('Assignments'); }, get hint() { return t('When work is assigned to you.'); } },
  { key: 'mentions', get label() { return t('Mentions'); }, get hint() { return t('When someone mentions you in a comment.'); } },
  { key: 'membership', get label() { return t('Project access'); }, get hint() { return t('When you are added to a project.'); } },
  {
    key: 'updates',
    get label() { return t('Updates to my work'); },
    get hint() { return t('Status and field changes on work you are assigned to or watch.'); },
  },
  {
    key: 'dueReminders',
    get label() { return t('Deadline reminders'); },
    get hint() { return t('A daily list of anything overdue or falling due shortly.'); },
  },
  { key: 'digest', get label() { return t('Daily digest'); }, get hint() { return t('A morning summary of what needs attention.'); } },
];

/**
 * Email about the things that are not work packages.
 *
 * Their own card, because they are their own streams with their own rhythms: an
 * announcement is occasional and usually wanted, a wiki edit can be constant and
 * usually is not. One switch governing both would be a question nobody can answer.
 */
const CONTENT_EMAIL_ROWS: { key: EmailSwitch; label: string; hint: string }[] = [
  { key: 'news', get label() { return t('News'); }, get hint() { return t('When an announcement is published to you.'); } },
  { key: 'meetings', get label() { return t('Meetings'); }, get hint() { return t('When you are invited to one, or it moves.'); } },
  { key: 'comments', get label() { return t('Comments'); }, get hint() { return t('New comments on work you are involved in.'); } },
  { key: 'wiki', get label() { return t('Wiki changes'); }, get hint() { return t('When a wiki page in your projects is edited.'); } },
  { key: 'documents', get label() { return t('Documents'); }, get hint() { return t('When a file is uploaded to one of your projects.'); } },
];

export function NotificationSettings() {
  const { user } = useAuth();
  const { preferences, update } = usePreferences();

  const pause = preferences.notifications.pause;
  const hours = hourOptions(preferences.workweek.timeFormat);

  return (
    <>
      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('In-app')}</CardTitle>
          <CardDescription>{t('What appears in your notifications feed.')}</CardDescription>
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
            <div className="px-4 py-2.5">
              <FieldHint>
                {t(
                  'Turning one off hides those items from your feed. Nothing is deleted, so switching it back on shows them again.',
                )}
              </FieldHint>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Email has its own card and its own master switch: it reaches the person
          while EPM is closed, so opting out of all of it has to be one movement
          rather than six. */}
      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Email')}</CardTitle>
          <CardDescription>
            {user?.email
              ? t('What EPM sends to {email}.', { email: user.email })
              : t('What EPM sends to your work email.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            <ToggleRow
              id="email-enabled"
              label={t('Send me email')}
              hint={t('Off means no email of any kind.')}
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

            <FieldRow
              label={t('Send reminders at')}
              hint={
                user?.timezone
                  ? t('{timezone}, not the server\'s.', { timezone: user.timezone.replace(/_/g, ' ') })
                  : t('Your timezone, not the server\'s.')
              }
              htmlFor="email-reminder-hour"
              disabled={!preferences.email.enabled}
            >
              <Select
                value={String(preferences.email.reminderHour)}
                disabled={!preferences.email.enabled}
                onValueChange={(value) => update('email', 'reminderHour', Number(value))}
              >
                <SelectTrigger id="email-reminder-hour" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hours.map((hour) => (
                    <SelectItem key={hour.value} value={hour.value}>
                      {hour.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>

            <FieldRow
              label={t('On these days')}
              hint={
                preferences.email.reminderDays.length === 0
                  ? t('No days selected, so no reminders are sent.')
                  : t('Reminders and the digest are only sent on these days.')
              }
              disabled={!preferences.email.enabled}
            >
              <WeekdayPicker
                label={t('Reminder days')}
                value={preferences.email.reminderDays}
                disabled={!preferences.email.enabled}
                onChange={(days) => update('email', 'reminderDays', days)}
              />
            </FieldRow>

            {!user?.timezone ? (
              <div className="px-4 py-2.5">
                {/* Worth saying plainly: without a timezone the hour above is
                    applied as UTC, which is not what the label implies. */}
                <Alert tone="neutral" icon={Clock}>
                  {t(
                    'You have not set a timezone, so the hour above is read as UTC. Set one under Profile and reminders will follow your own clock.',
                  )}
                </Alert>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Email about other content')}</CardTitle>
          <CardDescription>
            {t('News, meetings, comments, wiki pages and documents — everything that is not a task.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {CONTENT_EMAIL_ROWS.map((row) => (
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
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Pause')}</CardTitle>
          <CardDescription>{t('Stop everything reaching you for a while.')}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            <ToggleRow
              id="notify-pause"
              label={t('Pause notifications')}
              hint={t('No email of any kind is sent while paused. Items still collect in your feed, so nothing is lost.')}
              checked={pause.enabled}
              onCheckedChange={(checked) =>
                update('notifications', 'pause', { ...pause, enabled: checked })
              }
            />

            <div
              className={`grid gap-3 px-4 py-3 sm:grid-cols-2 ${pause.enabled ? '' : 'opacity-60'}`}
            >
              <div className="space-y-1.5">
                <Label htmlFor="pause-from">{t('From')}</Label>
                <Input
                  id="pause-from"
                  type="date"
                  value={pause.from ?? ''}
                  disabled={!pause.enabled}
                  onChange={(event) =>
                    update('notifications', 'pause', {
                      ...pause,
                      from: event.target.value || undefined,
                    })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pause-to">{t('Until')}</Label>
                <Input
                  id="pause-to"
                  type="date"
                  value={pause.to ?? ''}
                  disabled={!pause.enabled}
                  onChange={(event) =>
                    update('notifications', 'pause', {
                      ...pause,
                      to: event.target.value || undefined,
                    })
                  }
                />
                <FieldHint>{t('Leave both empty to pause until you turn it off.')}</FieldHint>
              </div>
            </div>

            {pause.enabled ? (
              <div className="px-4 py-2.5">
                <Alert tone="warning" icon={BellOff} title={t('Notifications are paused')}>
                  {pause.from && pause.to
                    ? t('Nothing will be emailed to you from {from} until {to}.', {
                        from: formatLongDate(pause.from),
                        to: formatLongDate(pause.to),
                      })
                    : pause.from
                      ? t('Nothing will be emailed to you from {from}.', { from: formatLongDate(pause.from) })
                      : pause.to
                        ? t('Nothing will be emailed to you until {to}.', { to: formatLongDate(pause.to) })
                        : t('Nothing will be emailed to you until you turn this off.')}
                </Alert>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
