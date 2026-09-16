import { cn, formatNumber, formatPercent } from '@/lib/utils';
import { HEALTH_META, PROJECT_STATUS_META, TONE_VAR, type Tone } from '@/lib/domain';
import type { HealthLevel, ProjectStatus } from '@/types';

/**
 * The marks portfolio pages are drawn from.
 *
 * Health and delivery status are *state*, so they wear the reserved status
 * colours rather than a categorical series palette — and never colour alone.
 * Two measured constraints force that:
 *
 * Healthy and Warning sit at ΔE 6.8 under protanopia, which is inside the band
 * that is only legal with a second encoding, and both sit under 3:1 against the
 * page, which obliges a visible label. So every segment here carries its count
 * in text and is separated by a 2px gap in the surface colour. Removing either
 * would leave a reader who cannot separate green from amber with nothing.
 *
 * The app has no dark mode by design (see `index.css`), so these are checked
 * against the light surface only.
 */

/** The 2px surface gap the mark spec puts between adjacent fills. */
const SEGMENT_GAP = 'gap-[2px]';

const HEALTH_ORDER: HealthLevel[] = ['healthy', 'warning', 'critical'];

interface ProportionSegment {
  key: string;
  label: string;
  count: number;
  tone: Tone;
}

/**
 * A part-to-whole bar for a handful of states.
 *
 * A bar rather than a donut: these are counts being compared against a total,
 * and a reader can line up bar lengths far more reliably than arc angles. An
 * empty total draws a flat rule instead of a bar, so nothing implies a
 * distribution that was never measured.
 */
function ProportionBar({
  segments,
  className,
}: {
  segments: ProportionSegment[];
  className?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);

  if (total === 0) {
    return <div className={cn('h-2 rounded-full bg-muted', className)} aria-hidden />;
  }

  return (
    <div
      className={cn('flex h-2 w-full overflow-hidden rounded-full', SEGMENT_GAP, className)}
      role="img"
      aria-label={segments
        .filter((segment) => segment.count > 0)
        .map((segment) => `${segment.label} ${segment.count}`)
        .join(', ')}
    >
      {segments
        .filter((segment) => segment.count > 0)
        .map((segment) => (
          <div
            key={segment.key}
            // Hover enhances rather than gates: every count is already written
            // out in the legend below, so nothing is reachable only this way.
            title={`${segment.label}: ${segment.count} of ${total} (${Math.round(
              (segment.count / total) * 100,
            )}%)`}
            className="h-full rounded-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${(segment.count / total) * 100}%`,
              background: TONE_VAR[segment.tone],
            }}
          />
        ))}
    </div>
  );
}

/**
 * The legend. Always rendered beside the bar it belongs to, because the colours
 * above cannot carry identity on their own — see the note at the top.
 */
function ProportionLegend({
  segments,
  showZero = false,
}: {
  segments: ProportionSegment[];
  showZero?: boolean;
}) {
  const shown = showZero ? segments : segments.filter((segment) => segment.count > 0);
  if (shown.length === 0) return null;

  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {shown.map((segment) => (
        <li key={segment.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: TONE_VAR[segment.tone] }}
          />
          {/* Text stays in ink tokens; the dot beside it carries identity. */}
          <span className="text-2xs text-muted-foreground">{segment.label}</span>
          <span className="font-mono text-2xs tabular-nums text-foreground">
            {formatNumber(segment.count)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** How a portfolio's projects are distributed across the three health states. */
export function HealthBar({
  health,
  showZero = false,
  className,
}: {
  health: Record<HealthLevel, number>;
  showZero?: boolean;
  className?: string;
}) {
  const segments: ProportionSegment[] = HEALTH_ORDER.map((level) => ({
    key: level,
    label: HEALTH_META[level].label,
    count: health[level],
    tone: HEALTH_META[level].tone,
  }));

  return (
    <div className={cn('space-y-1.5', className)}>
      <ProportionBar segments={segments} />
      <ProportionLegend segments={segments} showZero={showZero} />
    </div>
  );
}

/** How a portfolio's projects are distributed across delivery status. */
export function StatusBar({
  statuses,
  className,
}: {
  statuses: Record<ProjectStatus, number>;
  className?: string;
}) {
  const segments: ProportionSegment[] = (
    Object.keys(PROJECT_STATUS_META) as ProjectStatus[]
  ).map((status) => ({
    key: status,
    label: PROJECT_STATUS_META[status].label,
    count: statuses[status] ?? 0,
    tone: PROJECT_STATUS_META[status].tone,
  }));

  return (
    <div className={cn('space-y-1.5', className)}>
      <ProportionBar segments={segments} />
      <ProportionLegend segments={segments} />
    </div>
  );
}

/**
 * Completion across a portfolio's work.
 *
 * Summed from task counts rather than averaged from each project's percentage:
 * averaging would let a five-task project weigh as much as a five-hundred-task
 * one. With no tasks at all it says so instead of drawing a 0% that would read
 * as "nothing done" rather than "nothing to do".
 */
export function DeliveryProgress({
  completed,
  total,
  className,
}: {
  completed: number;
  total: number;
  className?: string;
}) {
  if (total === 0) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>
        No work packages yet, so there is no progress to measure.
      </p>
    );
  }

  const percent = Math.round((completed / total) * 100);

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-lg tabular-nums text-foreground">
          {formatPercent(percent)}
        </span>
        <span className="font-mono text-2xs tabular-nums text-muted-foreground">
          {formatNumber(completed)} / {formatNumber(total)} complete
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{ width: `${percent}%`, background: TONE_VAR.primary }}
        />
      </div>
    </div>
  );
}
