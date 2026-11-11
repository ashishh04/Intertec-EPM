import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useMeetings } from '@/hooks/useCollaborationModules';
import { t } from '@/lib/i18n';
import { formatLongDate, formatTime } from '@/lib/utils';
import type { ID } from '@/types';

/**
 * The meetings that have this task on their agenda, soonest first: where it was
 * or will be discussed. Shown only when there are any, and only meetings the
 * reader may see.
 */
export function TaskMeetings({ workPackageId }: { workPackageId: ID }) {
  const meetings = useMeetings({ workPackageId, window: 'all', pageSize: 10 });
  const items = meetings.data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader variant="compact" className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Discussed in meetings')}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {items.map((meeting) => (
            <li key={meeting.id}>
              <Link to={`/meetings/${meeting.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs hover:bg-muted/40">
                <span className="min-w-0 truncate font-medium" dir="auto">
                  {meeting.title}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {t('{date}, {time}', { date: formatLongDate(meeting.startsAt), time: formatTime(meeting.startsAt) })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
