import { PlateFrame } from './PlateFrame';

/**
 * Capacity and allocation: a delivery squad down the side, ten weeks across.
 *
 * The cells load and release on their own rhythm, which is the point of the
 * section it sits in — capacity is read from the work rather than declared up
 * front.
 *
 * Heat runs along the brand ramp rather than switching to an alarm colour:
 * faint, violet, magenta, crimson. So "busy" and "over" are the same scale
 * seen further along, which is what allocation actually is, and the plate
 * stays inside the identity instead of borrowing a warning red.
 *
 * Names are illustrative. Every figure on the plate — each person's
 * utilisation and the count in the footer — is computed from the matrix below
 * rather than typed alongside it, so the numbers cannot drift from the cells
 * they describe.
 */

/*
 * Mostly headroom, with two people over in specific weeks — which is the
 * situation the product exists to surface, and the one worth showing. An
 * evenly hot grid reads as a team in crisis and, at this size, as noise.
 */
const PEOPLE = [
  { name: 'A. Rahman', role: 'Delivery lead', initials: 'AR', load: '1222331211' },
  { name: 'S. Menon', role: 'Engineering', initials: 'SM', load: '1122232110' },
  { name: 'K. Fernandes', role: 'Engineering', initials: 'KF', load: '1223432211' },
  { name: 'L. Haddad', role: 'Data', initials: 'LH', load: '1122333421' },
  { name: 'M. Iyer', role: 'QA', initials: 'MI', load: '0112222211' },
  { name: 'D. Okoye', role: 'Platform', initials: 'DO', load: '1122321011' },
] as const;

const WEEKS = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];

/** What each level means as a share of a person's week. */
const LEVEL_LOAD = [0, 50, 80, 100, 125];
/** At or above this a week is over the line. */
const OVER_LEVEL = 4;

/** Grid geometry, in percent. The this-week band is positioned from these
 *  rather than placed as a grid item: an explicitly placed item is laid out
 *  before the auto-placed ones, which pushes six cells into an implicit
 *  seventh row and leaves a hole in the column it is meant to highlight. */
const COLUMN_GAP = 2.4;
const COLUMN_WIDTH = (100 - COLUMN_GAP * (WEEKS.length - 1)) / WEEKS.length;
/** Zero-indexed column the marker sits on. */
const THIS_WEEK = 4;

/*
 * The ramp. Level 3 and 4 carry a glow as well as a fill — on a dark plate a
 * flat swatch reads as a printed square, and the bloom is what makes the hot
 * weeks look lit from behind rather than coloured in.
 */
const INTENSITY = [
  'bg-white/[0.035] ring-1 ring-inset ring-white/[0.05]',
  'bg-[hsl(var(--brand-to)/0.3)]',
  'bg-[hsl(var(--brand-to)/0.62)]',
  'bg-[hsl(var(--highlight)/0.85)] shadow-[0_0_14px_-3px_hsl(var(--highlight)/0.9)]',
  'bg-[hsl(var(--brand-from)/0.95)] shadow-[0_0_16px_-2px_hsl(var(--brand-from))]',
];

/** Cells at or above this are "loaded" and get the breathing animation. */
const LIVE_FROM = 2;
const CYCLE_SECONDS = 9;

const levels = (load: string) => load.split('').map(Number);

/** Mean load across the ten weeks, as a percentage of capacity. */
const utilisation = (load: string) =>
  Math.round(levels(load).reduce((sum, level) => sum + LEVEL_LOAD[level], 0) / WEEKS.length);

const overCount = PEOPLE.filter((person) => levels(person.load).some((l) => l >= OVER_LEVEL)).length;

const LABEL = 'text-[clamp(8px,0.7vw,12px)] leading-none';
const MICRO = 'text-[clamp(6px,0.56vw,10px)] leading-none';

export function CapacityPlate() {
  return (
    <PlateFrame>
      <div className="absolute inset-[6%] flex flex-col">
        {/* ---- Header -------------------------------------------------- */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p
              className={`font-display font-semibold uppercase tracking-[0.2em] text-white/70 ${LABEL}`}
            >
              Capacity
            </p>
            <p className={`mt-[0.5em] font-mono text-white/30 ${MICRO}`}>
              Delivery squad · weeks {WEEKS[0]}–{WEEKS[WEEKS.length - 1]}
            </p>
          </div>

          <span
            className={`flex items-center gap-[0.5em] rounded-full bg-[hsl(var(--brand-from)/0.14)] px-[0.8em] py-[0.45em] font-mono text-[hsl(var(--brand-from))] ring-1 ring-inset ring-[hsl(var(--brand-from)/0.35)] ${MICRO}`}
          >
            <span className="h-[0.45em] w-[0.45em] rounded-full bg-[hsl(var(--brand-from))]" />
            {overCount} over capacity
          </span>
        </div>

        {/* ---- The grid ------------------------------------------------ */}
        <div className="mt-[4%] flex min-h-0 flex-1 gap-[3%] rounded-lg bg-white/[0.015] p-[2.5%] ring-1 ring-inset ring-white/[0.05]">
          <div className="flex w-[36%] shrink-0 flex-col">
            {/* Spacer matching the week ruler on the right */}
            <div className="h-[10%]" />
            <div className="grid flex-1 grid-rows-6">
              {PEOPLE.map((person) => {
                const percent = utilisation(person.load);
                return (
                  <div key={person.name} className="flex items-center gap-[6%]">
                    <span
                      className={`flex aspect-square h-[46%] shrink-0 items-center justify-center rounded-full bg-white/[0.07] font-medium text-white/60 ring-1 ring-inset ring-white/10 ${MICRO}`}
                    >
                      {person.initials}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-white/80 ${LABEL}`}>{person.name}</span>
                      <span className={`mt-[0.4em] block truncate text-white/30 ${MICRO}`}>
                        {person.role}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 font-mono tabular-nums ${MICRO} ${
                        percent > 100 ? 'text-[hsl(var(--brand-from))]' : 'text-white/40'
                      }`}
                    >
                      {percent}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {/* Week ruler. The current week is the only one lit. */}
            <div className="grid h-[10%] grid-cols-10 items-start">
              {WEEKS.map((week, index) => (
                <span
                  key={week}
                  className={`text-center font-mono tabular-nums ${MICRO} ${
                    index === THIS_WEEK ? 'text-white/75' : 'text-white/25'
                  }`}
                >
                  {week}
                </span>
              ))}
            </div>

            <div className="relative grid flex-1 grid-cols-10 grid-rows-6" style={{ gap: `${COLUMN_GAP}%` }}>
              {/* This week, as a lit band behind its column rather than a box
                  drawn around it — the outline read as a stray rectangle. */}
              <span
                className="pointer-events-none absolute inset-y-[-3%] rounded-md bg-white/[0.06] ring-1 ring-inset ring-white/[0.14]"
                style={{
                  left: `${THIS_WEEK * (COLUMN_WIDTH + COLUMN_GAP) - COLUMN_GAP / 2}%`,
                  width: `${COLUMN_WIDTH + COLUMN_GAP}%`,
                }}
              />

              {PEOPLE.map((person, row) =>
                levels(person.load).map((level, col) => (
                  <span
                    key={`${row}-${col}`}
                    className={`relative my-[7%] rounded-[3px] ${INTENSITY[level]}`}
                    style={
                      level >= LIVE_FROM
                        ? {
                            animation: `epm-cell-pulse ${CYCLE_SECONDS}s ease-in-out infinite`,
                            animationDelay: `${col * 0.16 + row * 0.09}s`,
                          }
                        : undefined
                    }
                  />
                )),
              )}
            </div>
          </div>
        </div>

        {/* ---- Legend -------------------------------------------------- */}
        <div className={`mt-[3.5%] flex items-center gap-[3%] ${MICRO}`}>
          <span className="text-white/35">Free</span>
          {/* One continuous ramp rather than three swatches: the scale is
              continuous, and saying so takes less room than a key. */}
          <span className="h-[0.5em] flex-1 rounded-full bg-gradient-to-r from-white/[0.08] via-[hsl(var(--brand-to))] to-[hsl(var(--brand-from))]" />
          <span className="text-white/35">Over</span>
          <span className="ml-[2%] font-mono tabular-nums text-white/30">
            {WEEKS.length} weeks · {PEOPLE.length} people
          </span>
        </div>
      </div>
    </PlateFrame>
  );
}
