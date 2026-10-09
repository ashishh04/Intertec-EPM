import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { OverviewQuery } from '@/services/api/portfolio-views';

/**
 * The period a portfolio overview counts over — for its period figures:
 * milestones due, work delivered. A saved view has its own, offered first.
 */

const PRESETS = [
  { id: '4w', label: 'Last 4 weeks', days: 28 },
  { id: '12w', label: 'Last 12 weeks', days: 84 },
  { id: '26w', label: 'Last 6 months', days: 182 },
  { id: '52w', label: 'Last 12 months', days: 365 },
] as const;

export type OverviewPeriodId = (typeof PRESETS)[number]['id'] | 'view';

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** The query a choice asks for: nothing for the view's own period. */
export function overviewQuery(id: OverviewPeriodId): OverviewQuery {
  const preset = PRESETS.find((entry) => entry.id === id);
  if (!preset) return {};
  const today = new Date();
  return { from: isoDay(new Date(today.getTime() - (preset.days - 1) * 86_400_000)), to: isoDay(today) };
}

export function OverviewPeriodSelect({
  value,
  onChange,
  viewPeriodLabel,
}: {
  value: OverviewPeriodId;
  onChange: (value: OverviewPeriodId) => void;
  /** Offers the saved view's own period, by name. */
  viewPeriodLabel?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as OverviewPeriodId)}>
      <SelectTrigger className={viewPeriodLabel ? 'h-8 w-64 text-xs' : 'h-8 w-48 text-xs'} aria-label="Period">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {viewPeriodLabel ? <SelectItem value="view">{viewPeriodLabel} (the view&rsquo;s)</SelectItem> : null}
        {PRESETS.map((preset) => (
          <SelectItem key={preset.id} value={preset.id}>
            {preset.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
