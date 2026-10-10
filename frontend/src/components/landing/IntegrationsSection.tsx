import { motion } from 'framer-motion';
import { Bot, CalendarClock, KeyRound, Mail, RadioTower, Workflow } from 'lucide-react';
import { useLandingMotion } from './useLandingMotion';
import { t } from '@/lib/i18n';

/*
 * The hero promises the platform is "connected to the systems teams already
 * work in" and then nothing on the page says which ones. These are the six
 * that exist, each one a thing the backend does rather than a logo wall:
 * the OpenProject boundary in `openproject/client.ts`, invitation-only
 * accounts in `routes/invites.ts`, the outbox in `email/outbox.ts`, the signed
 * webhook receiver in `routes/webhooks.ts`, Pragnya in `assistant/service.ts`,
 * and the nightly snapshot in `scheduler/analytics-snapshot.ts`.
 *
 * `where` is the posture, not the vendor: every one of these terminates in the
 * backend, which is the claim the section is really making.
 */
const CONNECTIONS = [
  {
    icon: Workflow,
    get title() { return t('Your delivery system of record'); },
    get body() { return t('Projects, work packages, versions and time entries are read and written upstream, so EPM reports on the same records your delivery tooling already holds — not a copy of them.'); },
    get where() { return t('Server-side only'); },
  },
  {
    icon: KeyRound,
    get title() { return t('Invitation-only accounts'); },
    get body() { return t('Access is provisioned by IT and arrives as an invitation, with your project membership and roles already set. There is no self-registration to get around them.'); },
    get where() { return t('Invitation only'); },
  },
  {
    icon: Mail,
    get title() { return t('Email that waits its turn'); },
    get body() { return t('Invitations, mentions, due reminders and digests are queued rather than sent inline, so a mail outage delays notice instead of failing the work that triggered it.'); },
    get where() { return t('Queued outbox'); },
  },
  {
    icon: RadioTower,
    get title() { return t('Changes made elsewhere'); },
    get body() { return t('Work updated outside EPM arrives as a signed delivery that clears what EPM has cached at once — so the next refresh shows the change, not a copy minutes old.'); },
    get where() { return t('Signed webhooks'); },
  },
  {
    icon: Bot,
    get title() { return t('Pragnya, in-app'); },
    get body() { return t('Ask about your own portfolios, sprints and workload in plain language. Every answer is assembled from records you are already allowed to open, through the same permission checks the screens use.'); },
    get where() { return t('Your data only'); },
  },
  {
    icon: CalendarClock,
    get title() { return t('Trend, captured nightly'); },
    get body() { return t('Velocity, health and capacity are snapshotted on a schedule, so a trend line is history rather than today recalculated and called a trend.'); },
    get where() { return t('Scheduled'); },
  },
];

/**
 * What EPM is plugged into.
 *
 * Set as an editorial list with hairlines rather than another card grid — the
 * two sections above this one are already cards, and a third grid would make
 * the page read as one long deck. Rows also let each claim have the sentence
 * it needs; a tile would cut them all to the shortest.
 */
export function IntegrationsSection() {
  const { reveal, drawRule } = useLandingMotion();

  return (
    <section
      id="integrations"
      className="relative scroll-mt-24 overflow-hidden px-6 py-28 md:py-40"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_30%_0%,_hsl(var(--brand-to)/0.12)_0%,_transparent_65%)]"
      />

      <div className="relative mx-auto max-w-6xl">
        <motion.div {...reveal(0, 0.7, { y: 30 })}>
          <p className="text-xs uppercase tracking-widest text-white/40">{t('Connected')}</p>
          <h2 className="mt-4 max-w-3xl text-3xl tracking-tight text-white md:text-5xl">
            {t('EPM joins what you already run,')}{' '}
            <em className="font-serif italic text-white/50">{t('it does not replace it')}</em>
          </h2>
          <p className="mt-6 max-w-2xl text-sm leading-relaxed text-white/50">
            {t(
              'Every connection below is made by the EPM backend, never by your browser. Your browser only ever talks to EPM — no upstream address, token or credential is ever sent to it.',
            )}
          </p>
        </motion.div>

        <ul className="mt-16">
          {CONNECTIONS.map((connection, index) => (
            <motion.li key={connection.title} {...reveal(Math.min(index, 4) * 0.06, 0.7, { y: 24 })}>
              {/* The rule belongs to the row below it, so the list opens on a
                  line and closes on copy — the same joint the page uses
                  between its sections. */}
              <span aria-hidden className="block h-px overflow-hidden bg-white/[0.07]">
                <motion.span
                  {...drawRule(Math.min(index, 4) * 0.08)}
                  className="block h-px origin-left rtl:origin-right bg-white/20"
                />
              </span>

              <div className="grid gap-4 py-7 md:grid-cols-[auto_1fr_auto] md:items-start md:gap-8 md:py-9">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-white">
                  <connection.icon className="h-4.5 w-4.5" aria-hidden />
                </span>

                <div className="md:max-w-3xl">
                  <h3 className="text-base font-semibold tracking-tight text-white md:text-lg">
                    {connection.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/50">{connection.body}</p>
                </div>

                {/* Reads as a property of the row on a wide screen and as a
                    tag under it on a phone, where a third column would squeeze
                    the copy to four words a line. */}
                <span className="liquid-glass justify-self-start rounded-full px-3.5 py-1.5 text-2xs uppercase tracking-widest text-white/60 md:justify-self-end">
                  {connection.where}
                </span>
              </div>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  );
}
