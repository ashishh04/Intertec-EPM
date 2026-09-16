import { PlateFrame } from './PlateFrame';

/**
 * Portfolio rollup: three projects and the single figure they add up to.
 *
 * The ring fills to portfolio health while the project rows underneath arrive
 * one at a time — health last, because it is a consequence of the rows rather
 * than a number someone typed.
 *
 * Each row carries its own status colour and dot, so the plate says which
 * project is the problem rather than just how full the bars are. Figures are
 * illustrative and match the product preview further down the page.
 */

/** r=42 in a 100-unit box. Kept as a constant because the dash maths needs it. */
const RING_RADIUS = 42;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const RING_FRACTION = 0.82;

const ROWS = [
  { label: 'Digital transformation', pct: 82, kind: 'portfolio', indent: 0 },
  { label: 'Core banking', pct: 64, kind: 'track', indent: 8 },
  { label: 'Retail portal', pct: 41, kind: 'risk', indent: 8 },
  { label: 'Network refresh', pct: 73, kind: 'track', indent: 8 },
] as const;

/*
 * Status tones come from the brand ramp, not from a traffic-light palette: the
 * page has one colour language and an alarm green would not belong to it. Teal
 * is the brand's own accent, magenta its gradient midpoint.
 */
const KIND: Record<(typeof ROWS)[number]['kind'], { bar: string; dot: string }> = {
  portfolio: {
    bar: 'bg-brand-diagonal shadow-[0_0_16px_-4px_hsl(var(--brand-to))]',
    dot: 'bg-[hsl(var(--brand-from))]',
  },
  track: {
    bar: 'bg-accent shadow-[0_0_14px_-5px_hsl(var(--accent))]',
    dot: 'bg-accent',
  },
  risk: {
    bar: 'bg-highlight shadow-[0_0_14px_-4px_hsl(var(--highlight))]',
    dot: 'bg-highlight',
  },
};

const atRisk = ROWS.filter((row) => row.kind === 'risk').length;

const CYCLE_SECONDS = 11;

const LABEL = 'text-[clamp(7px,0.62vw,11px)] leading-none';
const MICRO = 'text-[clamp(6px,0.52vw,10px)] leading-none';

export function PortfolioPlate() {
  return (
    <PlateFrame>
      <div className="absolute inset-[7%] flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p
              className={`font-display font-semibold uppercase tracking-[0.2em] text-white/70 ${LABEL}`}
            >
              Portfolio health
            </p>
            <p className={`mt-[0.5em] font-mono text-white/30 ${MICRO}`}>
              {ROWS.length - 1} projects · FY26 Q4
            </p>
          </div>

          <span
            className={`flex items-center gap-[0.5em] rounded-full bg-[hsl(var(--highlight)/0.14)] px-[0.8em] py-[0.45em] font-mono text-[hsl(var(--highlight))] ring-1 ring-inset ring-[hsl(var(--highlight)/0.35)] ${MICRO}`}
          >
            <span className="h-[0.45em] w-[0.45em] rounded-full bg-[hsl(var(--highlight))]" />
            {atRisk} at risk
          </span>
        </div>

        <div className="mt-[3%] flex min-h-0 flex-1 items-center gap-[6%]">
          {/* Health */}
          <div className="relative aspect-square h-[86%] shrink-0">
            <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
              <defs>
                <linearGradient id="epm-ring" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--brand-from))" />
                  <stop offset="100%" stopColor="hsl(var(--brand-to))" />
                </linearGradient>
              </defs>
              <circle
                cx="50"
                cy="50"
                r={RING_RADIUS}
                fill="none"
                stroke="rgba(255,255,255,0.07)"
                strokeWidth="7"
              />
              <circle
                cx="50"
                cy="50"
                r={RING_RADIUS}
                fill="none"
                stroke="url(#epm-ring)"
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={RING_LENGTH}
                style={
                  {
                    '--ring-length': RING_LENGTH,
                    '--ring-offset': RING_LENGTH * (1 - RING_FRACTION),
                    strokeDashoffset: RING_LENGTH,
                    animation: `epm-ring-draw ${CYCLE_SECONDS}s cubic-bezier(0.32,0.72,0,1) infinite`,
                    filter: 'drop-shadow(0 0 6px hsl(var(--brand-to) / 0.55))',
                  } as React.CSSProperties
                }
              />
            </svg>
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-[0.45em]">
              <span className="font-display text-[clamp(14px,1.6vw,28px)] font-semibold leading-none tracking-tight text-white">
                82%
              </span>
              <span className={`uppercase tracking-[0.16em] text-white/40 ${MICRO}`}>On track</span>
            </span>
          </div>

          {/* The rows it is made of */}
          <div className="relative grid h-full flex-1 grid-rows-4 items-center">
            {/* The rail that ties the projects to the portfolio above them */}
            <span className="absolute bottom-[14%] left-[2%] top-[32%] w-px bg-white/10" />

            {ROWS.map((row, index) => (
              <div key={row.label} style={{ paddingLeft: `${row.indent}%` }}>
                <div className={`flex items-center gap-[3%] ${LABEL}`}>
                  <span className={`h-[0.5em] w-[0.5em] shrink-0 rounded-full ${KIND[row.kind].dot}`} />
                  <span className="truncate text-white/70">{row.label}</span>
                  <span className="ml-auto shrink-0 font-mono tabular-nums text-white/45">
                    {row.pct}%
                  </span>
                </div>
                <span className="relative mt-[0.55em] block h-[5px] overflow-hidden rounded-full bg-white/[0.05] ring-1 ring-inset ring-white/[0.04]">
                  <span
                    className={`absolute inset-y-0 left-0 origin-left rounded-full ${KIND[row.kind].bar}`}
                    style={{
                      width: `${row.pct}%`,
                      animation: `epm-bar-draw ${CYCLE_SECONDS}s cubic-bezier(0.32,0.72,0,1) infinite`,
                      animationDelay: `${index * 0.18}s`,
                    }}
                  />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </PlateFrame>
  );
}
