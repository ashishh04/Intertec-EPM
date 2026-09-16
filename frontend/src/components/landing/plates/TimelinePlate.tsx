import { PlateFrame } from './PlateFrame';

/**
 * The signature plate: a delivery schedule resolving itself.
 *
 * Bars grow out of their start dates in dependency order, the elbows joining
 * them fade in once both ends exist, milestones land, and a today-line crosses
 * the whole thing. Every position is a percentage derived from the same few
 * constants as the links, so the bars and the lines between them can never
 * drift apart at a different aspect ratio.
 *
 * The labels matter as much as the bars: without them the plate reads as a
 * loading skeleton rather than as a schedule. Every name here is illustrative —
 * the same fictional programme the product preview lower down the page uses.
 */

/** Room above the first track for the header and the month ruler, and below
 *  the last one for the plate to breathe. */
const PAD_TOP = 24;
const PAD_BOTTOM = 10;

const MONTHS = ['SEP', 'OCT', 'NOV', 'DEC', 'JAN', 'FEB', 'MAR', 'APR'];

const TRACKS = [
  { label: 'Discovery & scope', left: 4, width: 20, tone: 'muted' },
  { label: 'Core banking migration', left: 8, width: 26, tone: 'brand', pct: '86%' },
  { label: 'Vendor onboarding', left: 22, width: 16, tone: 'muted' },
  { label: 'Retail portal rollout', left: 30, width: 24, tone: 'accent' },
  { label: 'Data platform build', left: 44, width: 32, tone: 'brand', pct: '64%' },
  { label: 'Network refresh', left: 52, width: 18, tone: 'muted' },
  { label: 'UAT & sign-off', left: 60, width: 24, tone: 'muted' },
  { label: 'Cutover rehearsal', left: 68, width: 20, tone: 'accent' },
  { label: 'Hypercare', left: 74, width: 18, tone: 'muted' },
] as const;

/** Drawn as elbows: the end of one bar down to the start of the next. */
const LINKS = [
  [1, 2],
  [2, 4],
  [3, 5],
  [5, 7],
] as const;

/**
 * Phase ends rather than task ends, so they carry a name. Two constraints on
 * where they can go: a milestone and a percentage both sit at the end of their
 * bar, so no track may carry both, and the last rows pass under the section's
 * call-to-action button, so a label there is printed over from the outside.
 * These two sit on unlabelled tracks in the clear upper half.
 */
const MILESTONES: Record<number, string> = { 0: 'KICK-OFF', 6: 'GO-LIVE' };

const TONE_CLASS: Record<(typeof TRACKS)[number]['tone'], string> = {
  brand: 'bg-brand shadow-[0_0_12px_-2px_hsl(var(--brand-to)/0.9)]',
  accent: 'bg-accent/80',
  muted: 'bg-white/[0.16]',
};

/** The vertical centre of a track, in percent of the plate's height. */
const rowY = (index: number) =>
  PAD_TOP + ((100 - PAD_TOP - PAD_BOTTOM) * (index + 0.5)) / TRACKS.length;

/** One full pass of the plate. Every element's delay is a fraction of this. */
const CYCLE_SECONDS = 13;

/** Plate type tracks the viewport, so the labels stay readable in the wide
 *  frame on a desktop and do not turn to mush on a phone. */
const LABEL = 'text-[clamp(8px,0.72vw,12px)] leading-none';

export function TimelinePlate() {
  return (
    <PlateFrame>
      {/* Header */}
      <div className={`absolute inset-x-[4%] top-[6%] flex items-center justify-between ${LABEL}`}>
        <span className="font-display font-semibold uppercase tracking-[0.18em] text-white/55">
          Delivery timeline
        </span>
        <span className="font-mono text-white/35">FY26 · Q3–Q4</span>
      </div>

      {/* Month ruler */}
      <div className="absolute inset-x-0 top-[13%] flex h-[6%] items-start">
        {MONTHS.map((month) => (
          <span
            key={month}
            className={`w-[12.5%] border-l border-white/10 pl-[4%] font-mono text-white/30 ${LABEL}`}
          >
            {month}
          </span>
        ))}
      </div>

      {/* Dependency elbows, under the bars so a link never crosses a bar face */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        {LINKS.map(([from, to], index) => {
          const startX = TRACKS[from].left + TRACKS[from].width;
          const endX = TRACKS[to].left;
          const elbowX = Math.min(startX + 2, endX);
          return (
            <path
              key={index}
              d={`M ${startX} ${rowY(from)} H ${elbowX} V ${rowY(to)} H ${endX}`}
              fill="none"
              stroke="rgba(255,255,255,0.28)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              style={{
                animation: `epm-link-in ${CYCLE_SECONDS}s ease-in-out infinite`,
                animationDelay: `${0.25 + index * 0.1}s`,
              }}
            />
          );
        })}
      </svg>

      {TRACKS.map((track, index) => (
        <div key={track.label}>
          {/* Task name, sitting on the bar's start date */}
          <span
            className={`absolute -translate-y-[190%] whitespace-nowrap text-white/60 ${LABEL}`}
            style={{
              top: `${rowY(index)}%`,
              left: `${track.left}%`,
              animation: `epm-label-in ${CYCLE_SECONDS}s ease-in-out infinite`,
              animationDelay: `${index * 0.14}s`,
            }}
          >
            {track.label}
          </span>

          {/* The empty track the bar sits on */}
          <span
            className="absolute h-[1%] min-h-[2px] -translate-y-1/2 rounded-full bg-white/[0.05]"
            style={{ top: `${rowY(index)}%`, left: '4%', right: '6%' }}
          />
          <span
            className={`absolute h-[2.2%] min-h-[4px] origin-left -translate-y-1/2 rounded-full ${TONE_CLASS[track.tone]}`}
            style={{
              top: `${rowY(index)}%`,
              left: `${track.left}%`,
              width: `${track.width}%`,
              animation: `epm-bar-draw ${CYCLE_SECONDS}s cubic-bezier(0.32,0.72,0,1) infinite`,
              animationDelay: `${index * 0.14}s`,
            }}
          />

          {/* Percent complete, for the bars that carry the brand sweep. Never
              drawn where a milestone already occupies the bar's end. */}
          {'pct' in track && !MILESTONES[index] ? (
            <span
              className={`absolute -translate-y-1/2 pl-[0.8%] font-mono text-white/45 ${LABEL}`}
              style={{
                top: `${rowY(index)}%`,
                left: `${track.left + track.width}%`,
                animation: `epm-label-in ${CYCLE_SECONDS}s ease-in-out infinite`,
                animationDelay: `${0.25 + index * 0.14}s`,
              }}
            >
              {track.pct}
            </span>
          ) : null}

          {MILESTONES[index] ? (
            <>
              <span
                className="absolute h-[2.6%] min-h-[5px] w-[1%] min-w-[5px] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-brand-from"
                style={{
                  top: `${rowY(index)}%`,
                  left: `${track.left + track.width}%`,
                  animation: `epm-link-in ${CYCLE_SECONDS}s ease-in-out infinite`,
                  animationDelay: `${0.3 + index * 0.14}s`,
                }}
              />
              <span
                className={`absolute -translate-y-1/2 whitespace-nowrap pl-[1.4%] font-mono tracking-[0.12em] text-brand-from/90 ${LABEL}`}
                style={{
                  top: `${rowY(index)}%`,
                  left: `${track.left + track.width}%`,
                  animation: `epm-link-in ${CYCLE_SECONDS}s ease-in-out infinite`,
                  animationDelay: `${0.45 + index * 0.14}s`,
                }}
              >
                {MILESTONES[index]}
              </span>
            </>
          ) : null}
        </div>
      ))}

      {/* Today */}
      <div
        className="absolute inset-y-0 left-0 w-full"
        style={{ animation: `epm-sweep-x ${CYCLE_SECONDS}s linear infinite` }}
      >
        <span className="absolute inset-y-[18%] left-0 w-px bg-gradient-to-b from-transparent via-white/70 to-transparent" />
        <span className="absolute inset-y-[18%] left-0 w-[6px] -translate-x-1/2 bg-gradient-to-r from-transparent via-white/12 to-transparent blur-[2px]" />
        <span
          className={`absolute left-0 top-[16%] -translate-x-1/2 whitespace-nowrap rounded-full bg-white/12 px-[0.6em] py-[0.35em] font-mono tracking-[0.14em] text-white/70 ${LABEL}`}
        >
          TODAY
        </span>
      </div>
    </PlateFrame>
  );
}
