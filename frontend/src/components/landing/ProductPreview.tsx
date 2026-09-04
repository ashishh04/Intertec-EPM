import { Bell, FolderKanban, Layers, ListChecks, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A static abstraction of the signed-in product, used as the hero visual.
 *
 * Deliberately not a screenshot and not live data: it has to stay readable at
 * any width and must never imply real figures. Every number here is
 * illustrative — see ILLUSTRATIVE_* below.
 */

const RAIL_ICONS = [Layers, FolderKanban, ListChecks, TrendingUp, Bell];

/** Illustrative only — not read from the API. */
const ILLUSTRATIVE_KPIS = [
  { label: 'Portfolios', value: '12' },
  { label: 'Active projects', value: '148' },
  { label: 'On track', value: '82%' },
];

/** Illustrative sprint velocity, as a fraction of the tallest bar. */
const ILLUSTRATIVE_VELOCITY = [0.38, 0.52, 0.44, 0.62, 0.5, 0.66, 0.55, 0.74, 0.6, 0.88, 0.8, 1];

/** The three most recent bars read as "now" and carry the solid fill. */
const RECENT_BARS = 3;

const ILLUSTRATIVE_ROWS = [
  { title: 'Core banking migration — Sprint 24', status: 'On track', tone: 'success' },
  { title: 'Retail portal rollout — UAT sign-off', status: 'At risk', tone: 'warning' },
  { title: 'Network refresh — capacity plan', status: 'In review', tone: 'primary' },
  { title: 'Data platform — dependency audit', status: 'Queued', tone: 'neutral' },
] as const;

const TONE_STYLES: Record<(typeof ILLUSTRATIVE_ROWS)[number]['tone'], { dot: string; pill: string }> = {
  success: { dot: 'bg-success', pill: 'bg-success-soft text-success' },
  warning: { dot: 'bg-warning', pill: 'bg-warning-soft text-warning' },
  primary: { dot: 'bg-primary', pill: 'bg-primary-soft text-primary' },
  neutral: { dot: 'bg-muted-foreground/50', pill: 'bg-muted text-muted-foreground' },
};

export function ProductPreview({ className }: { className?: string }) {
  return (
    // aria-hidden: it is decoration. The capability list below states the same
    // thing in words, so a screen reader loses nothing by skipping it.
    <div
      aria-hidden
      className={cn(
        'select-none overflow-hidden rounded-xl border border-border bg-surface shadow-elevated',
        className,
      )}
    >
      {/* Title bar */}
      <div className="flex h-9 items-center gap-3 border-b border-border bg-surface-sunken px-3.5">
        <div className="flex gap-1.5">
          <span className="h-2 w-2 rounded-full bg-danger/60" />
          <span className="h-2 w-2 rounded-full bg-warning/60" />
          <span className="h-2 w-2 rounded-full bg-success/60" />
        </div>
        <p className="font-mono text-2xs text-muted-foreground">
          epm <span className="text-muted-foreground/60">/ delivery overview</span>
        </p>
      </div>

      <div className="flex">
        {/* Icon rail */}
        <div className="flex w-11 shrink-0 flex-col items-center gap-1.5 border-r border-border py-3">
          {RAIL_ICONS.map((Icon, index) => (
            <span
              key={index}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-lg',
                index === 0 ? 'bg-primary-soft text-primary' : 'text-muted-foreground/50',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1 space-y-3 p-3.5">
          {/* KPI tiles */}
          <div className="grid grid-cols-3 gap-2.5">
            {ILLUSTRATIVE_KPIS.map((kpi) => (
              <div key={kpi.label} className="rounded-lg border border-border bg-surface p-2.5">
                <p className="truncate text-2xs text-muted-foreground">{kpi.label}</p>
                <p className="mt-1 font-mono text-lg font-semibold leading-none tracking-tight">
                  {kpi.value}
                </p>
              </div>
            ))}
          </div>

          {/* Velocity */}
          <div className="rounded-lg border border-border bg-surface p-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-2xs text-muted-foreground">Velocity · last 12 sprints</p>
              <p className="font-mono text-2xs font-medium text-success">+14%</p>
            </div>
            <div className="mt-2.5 flex h-14 items-end gap-1.5">
              {ILLUSTRATIVE_VELOCITY.map((height, index) => (
                <span
                  key={index}
                  style={{ height: `${Math.round(height * 100)}%` }}
                  className={cn(
                    'flex-1 rounded-md',
                    index >= ILLUSTRATIVE_VELOCITY.length - RECENT_BARS
                      ? 'bg-primary'
                      : 'bg-primary/25',
                  )}
                />
              ))}
            </div>
          </div>

          {/* Work rows */}
          <div className="space-y-1.5">
            {ILLUSTRATIVE_ROWS.map((row) => {
              const tone = TONE_STYLES[row.tone];
              return (
                <div
                  key={row.title}
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2"
                >
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tone.dot)} />
                  <p className="min-w-0 flex-1 truncate text-2xs text-foreground">{row.title}</p>
                  <span
                    className={cn(
                      'shrink-0 rounded-md px-1.5 py-0.5 text-[0.625rem] font-medium',
                      tone.pill,
                    )}
                  >
                    {row.status}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
