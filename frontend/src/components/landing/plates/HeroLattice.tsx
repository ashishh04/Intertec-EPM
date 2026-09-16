/**
 * The hero's ground: a schedule receding to a horizon.
 *
 * The same ribbons as the timeline plate, laid flat in perspective and drifting
 * so the field never sits still. It is the one plate that is pure atmosphere —
 * the headline sits on top of it, so it has to stay quiet: no element brighter
 * than 14% white except a handful of brand-tinted bars, and the whole field
 * masked away before it reaches the type.
 *
 * Rows are generated rather than hand-written, but deterministically: a fixed
 * seed per row, so the field is identical on every render and every screenshot.
 */

const ROW_COUNT = 16;
const BARS_PER_ROW = 7;
/** Total width the bars take up in a row, leaving the rest as gaps. */
const FILL = 86;

/** Widths for one row, as percentages of half the drifting strip. */
function rowBars(row: number) {
  const raw: number[] = [];
  let seed = row * 37 + 11;
  for (let i = 0; i < BARS_PER_ROW; i += 1) {
    seed = (seed * 61 + 17) % 97;
    raw.push(6 + (seed % 16));
  }
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value, index) => ({
    width: (value / total) * FILL,
    // Roughly one bar in seven carries brand colour; the rest are the neutral
    // greys of work that is simply on the plan.
    tone:
      (row * 3 + index) % 13 === 0
        ? 'bg-[hsl(var(--brand-from)/0.6)]'
        : (row + index) % 7 === 0
          ? 'bg-[hsl(var(--brand-to)/0.65)]'
          : index % 3 === 0
            ? 'bg-white/[0.16]'
            : 'bg-white/[0.08]',
  }));
}

export function HeroLattice() {
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden">
      {/*
       * The plane is anchored to the hero's bottom edge and overruns it above,
       * because rotating about that edge compresses everything above it toward
       * the horizon — an element only as tall as the hero would end up as a
       * thin strip along the floor.
       */}
      <div className="absolute inset-x-[-40%] bottom-0 top-[-40%] [perspective:1600px]">
        <div className="flex h-full w-full flex-col justify-end gap-[2.6%] [mask-image:linear-gradient(to_top,black_0%,black_14%,transparent_66%)] [transform-origin:50%_100%] [transform:rotateX(66deg)]">
          {Array.from({ length: ROW_COUNT }).map((_, row) => {
            const bars = rowBars(row);
            return (
              <div key={row} className="relative h-[1.1%] shrink-0 overflow-hidden">
                <div
                  className="epm-drift-x absolute inset-y-0 left-0 flex w-[200%]"
                  // Far rows drift slower, which is what sells the depth.
                  style={{ animationDuration: `${52 + row * 7}s` }}
                >
                  {[0, 1].map((copy) => (
                    <div key={copy} className="flex w-1/2 shrink-0 items-center justify-between">
                      {bars.map((bar, index) => (
                        <span
                          key={index}
                          className={`h-full rounded-full ${bar.tone}`}
                          style={{ width: `${bar.width}%` }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Pulls the light to the centre and keeps the corners black. */}
      <div className="absolute inset-0 bg-[radial-gradient(95%_70%_at_50%_100%,transparent_20%,rgba(0,0,0,0.7)_100%)]" />
    </div>
  );
}
