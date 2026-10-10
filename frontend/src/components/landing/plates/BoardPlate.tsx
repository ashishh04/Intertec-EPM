import { PlateFrame } from './PlateFrame';
import { t } from '@/lib/i18n';

/**
 * A board with one card actually crossing it.
 *
 * Three columns, a settled backlog in each, and a single live card carried
 * from left to right and back. The moving card is the only lit thing on the
 * plate: the columns are the state, the card is the delivery. Titles are
 * illustrative.
 */

/** Column gap, as a percentage of the plate's width. Shared with the travel
 *  keyframes in index.css, which step by a column's own width plus this gap. */
const GAP = 4;
const COLUMN_WIDTH = `calc((100% - ${GAP * 2}%) / 3)`;

const COLUMNS = [
  {
    get name() { return t('Backlog'); },
    count: 12,
    cards: [
      { get title() { return t('Dependency audit'); }, get tag() { return t('Data'); }, who: 'LH', tone: 'bg-white/25' },
      { get title() { return t('Capacity plan · Q4'); }, get tag() { return t('PMO'); }, who: 'AR', tone: 'bg-white/25' },
    ],
  },
  {
    get name() { return t('In progress'); },
    count: 5,
    cards: [
      { get title() { return t('API contract v2'); }, get tag() { return t('Platform'); }, who: 'DO', tone: 'bg-accent' },
      { get title() { return t('Migration dry run'); }, get tag() { return t('Core'); }, who: 'KF', tone: 'bg-accent' },
    ],
  },
  {
    get name() { return t('Done'); },
    count: 28,
    cards: [
      { get title() { return t('Env provisioning'); }, get tag() { return t('Infra'); }, who: 'DO', tone: 'bg-white/20' },
      { get title() { return t('Schema freeze'); }, get tag() { return t('Data'); }, who: 'LH', tone: 'bg-white/20' },
    ],
  },
] as const;

const CYCLE_SECONDS = 10;

const LABEL = 'text-[clamp(6px,0.52vw,10px)] leading-none';

function Card({
  title,
  tag,
  who,
  tone,
  className = '',
}: {
  title: string;
  tag: string;
  who: string;
  tone: string;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col justify-center gap-[0.65em] rounded-[5px] p-[7%] ring-1 ring-inset ring-white/[0.06] ${className}`}
    >
      <span className={`truncate text-white/75 ${LABEL}`}>{title}</span>
      <span className="flex items-center gap-[0.5em]">
        <span className={`h-[0.5em] w-[2.2em] rounded-full ${tone}`} />
        <span className={`truncate uppercase tracking-[0.12em] text-white/30 ${LABEL}`}>{tag}</span>
        <span
          className={`ms-auto flex aspect-square h-[1.7em] shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-white/50 ring-1 ring-inset ring-white/10 ${LABEL}`}
        >
          {who}
        </span>
      </span>
    </div>
  );
}

export function BoardPlate() {
  return (
    <PlateFrame>
      <div className="absolute inset-[7%] flex flex-col">
        <div className={`flex items-baseline justify-between gap-3 ${LABEL}`}>
          <span className="font-display font-semibold uppercase tracking-[0.2em] text-white/70">
            {t('Sprint 24')}
          </span>
          <span className="font-mono tabular-nums text-white/30">{t('4 days left')}</span>
        </div>

        <div className="relative mt-[4%] flex-1">
          <div className="flex h-full items-stretch" style={{ gap: `${GAP}%` }}>
            {COLUMNS.map((column) => (
              <div
                key={column.name}
                className="flex flex-col gap-[4%] rounded-lg bg-white/[0.015] p-[4%] ring-1 ring-inset ring-white/[0.04]"
                style={{ width: COLUMN_WIDTH }}
              >
                <div className={`flex shrink-0 items-baseline justify-between gap-[4%] ${LABEL}`}>
                  <span className="truncate font-display font-semibold uppercase tracking-[0.14em] text-white/55">
                    {column.name}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-white/30">
                    {column.count}
                  </span>
                </div>

                {column.cards.map((card) => (
                  <Card key={card.title} {...card} className="h-[22%] shrink-0 bg-white/[0.05]" />
                ))}
              </div>
            ))}
          </div>

          {/* The card in flight. The travel keyframes step by a column's own
              width plus the gap, so it lands square in each column — and it
              rides in the lane below the settled cards, so it never comes to
              rest on top of one. */}
          <div
            className="absolute start-0 top-[70%] h-[22%]"
            style={{
              width: COLUMN_WIDTH,
              animation: `epm-card-travel ${CYCLE_SECONDS}s cubic-bezier(0.65,0,0.35,1) infinite`,
            }}
          >
            <Card
              title={t('Sprint 24 · UAT sign-off')}
              tag={t('Retail')}
              who="MI"
              tone="bg-brand-diagonal"
              className="h-full bg-white/[0.11] shadow-[0_10px_30px_-8px_hsl(var(--brand-to))] !ring-white/25"
            />
          </div>
        </div>
      </div>
    </PlateFrame>
  );
}
