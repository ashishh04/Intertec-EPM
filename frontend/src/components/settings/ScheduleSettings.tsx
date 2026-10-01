import { Link } from 'react-router-dom';
import { ArrowRight, Plane } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { FactList } from '@/components/common/FactList';
import { FieldRow, ToggleRow, WeekdayPicker } from './SettingsRows';
import { usePreferences } from '@/hooks/usePreferences';
import { useEmployee } from '@/hooks/useEmployees';
import { useAuth } from '@/providers/AuthProvider';
import { formatHours, formatLongDate } from '@/lib/utils';

/**
 * Schedule and availability.
 *
 * The distinction this card is built around: weekly capacity is an
 * administrator's figure — it drives team totals and portfolio planning, so it is
 * set on the Employees page and only shown here. The working week and out-of-
 * office are the person's own, and both change behaviour rather than only
 * describing it: the timesheet marks days outside the working week, and nothing
 * scheduled is emailed to somebody who is away.
 */
export function ScheduleSettings() {
  const { user } = useAuth();
  const { preferences, update } = usePreferences();
  const profile = useEmployee(user?.id);

  const { workingDays, hoursPerDay, outOfOffice } = preferences.availability;
  const capacity = profile.data?.hoursCapacity;

  // What the declared week adds up to, which is the number that can contradict
  // the contracted figure beside it.
  const declared = workingDays.length * hoursPerDay;
  const mismatch =
    capacity !== undefined && capacity > 0 && Math.abs(declared - capacity) >= 0.5;

  return (
    <>
      <Card>
        <CardHeader variant="compact">
          <CardTitle>Working week</CardTitle>
          <CardDescription>The days and hours your week normally covers.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            <FieldRow
              label="Working days"
              hint="Days outside these are marked as non-working on your timesheet."
            >
              <WeekdayPicker
                label="Working days"
                value={workingDays}
                onChange={(days) => update('availability', 'workingDays', days)}
              />
            </FieldRow>

            <FieldRow
              label="Hours in a normal day"
              hint="Used to read a day's logged time against."
              htmlFor="schedule-hours"
            >
              <Input
                id="schedule-hours"
                type="number"
                min={0}
                max={24}
                step={0.25}
                className="w-24"
                value={String(hoursPerDay)}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  // Rejected here rather than saved and refused: the field is a
                  // number input, so anything out of range is a slip.
                  if (!Number.isFinite(next) || next < 0 || next > 24) return;
                  update('availability', 'hoursPerDay', next);
                }}
              />
            </FieldRow>

            <div className="px-4 py-3">
              <FactList
                facts={[
                  {
                    label: 'Your week, as declared',
                    value: `${formatHours(declared)} across ${workingDays.length} ${
                      workingDays.length === 1 ? 'day' : 'days'
                    }`,
                    mono: false,
                  },
                  {
                    label: 'Contracted capacity',
                    mono: false,
                    value:
                      capacity === undefined ? (
                        <span className="text-muted-foreground">Not set</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          {formatHours(capacity)}
                          <Badge tone="neutral" size="sm">
                            Set by an administrator
                          </Badge>
                        </span>
                      ),
                  },
                ]}
              />

              {mismatch ? (
                <Alert tone="neutral" className="mt-3">
                  Your declared week comes to {formatHours(declared)} and your contracted capacity is{' '}
                  {formatHours(capacity!)}. Neither overrides the other — capacity drives team and
                  portfolio totals, and this drives how your own timesheet reads — but a large gap is
                  usually worth a word with whoever does staffing.
                </Alert>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader variant="compact">
          <CardTitle>Out of office</CardTitle>
          <CardDescription>While you are away.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            <ToggleRow
              id="ooo-enabled"
              label="I am out of office"
              hint="Deadline reminders and the daily digest are held. Mentions and assignments still reach you — those are people, not the system."
              checked={outOfOffice.enabled}
              onCheckedChange={(checked) =>
                update('availability', 'outOfOffice', { ...outOfOffice, enabled: checked })
              }
            />

            <div className={`space-y-3 px-4 py-3 ${outOfOffice.enabled ? '' : 'opacity-60'}`}>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ooo-from">From</Label>
                  <Input
                    id="ooo-from"
                    type="date"
                    value={outOfOffice.from ?? ''}
                    disabled={!outOfOffice.enabled}
                    onChange={(event) =>
                      update('availability', 'outOfOffice', {
                        ...outOfOffice,
                        from: event.target.value || undefined,
                      })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ooo-to">Until</Label>
                  <Input
                    id="ooo-to"
                    type="date"
                    value={outOfOffice.to ?? ''}
                    disabled={!outOfOffice.enabled}
                    onChange={(event) =>
                      update('availability', 'outOfOffice', {
                        ...outOfOffice,
                        to: event.target.value || undefined,
                      })
                    }
                  />
                  <FieldHint>Leave both empty to stay marked away until you turn it off.</FieldHint>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ooo-note">Note for colleagues</Label>
                <Textarea
                  id="ooo-note"
                  rows={2}
                  maxLength={280}
                  placeholder="Back on the 12th — ask Priya about the migration."
                  value={outOfOffice.note ?? ''}
                  disabled={!outOfOffice.enabled}
                  onChange={(event) =>
                    update('availability', 'outOfOffice', {
                      ...outOfOffice,
                      note: event.target.value || undefined,
                    })
                  }
                />
                <FieldHint>Shown on your profile. Keep it to what someone needs to act.</FieldHint>
              </div>
            </div>

            {outOfOffice.enabled ? (
              <div className="px-4 py-2.5">
                <Alert tone="warning" icon={Plane} title="Marked as away">
                  {outOfOffice.from || outOfOffice.to
                    ? `${outOfOffice.from ? `From ${formatLongDate(outOfOffice.from)}` : 'Until further notice'}${
                        outOfOffice.to ? ` until ${formatLongDate(outOfOffice.to)}` : ''
                      }.`
                    : 'Until you turn this off.'}
                </Alert>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader variant="compact">
          <CardTitle>Your time</CardTitle>
          <CardDescription>Where the hours behind this actually live.</CardDescription>
        </CardHeader>
        <CardContent className="p-4">
          <Button asChild variant="secondary" size="sm">
            <Link to="/my-time">
              Open my timesheet
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
