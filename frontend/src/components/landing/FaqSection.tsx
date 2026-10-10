import { useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Plus } from 'lucide-react';
import { useLandingMotion } from './useLandingMotion';
import { APP_NAME, ORG_NAME } from '@/config/env';
import { t } from '@/lib/i18n';

/*
 * The six things a signed-out member of staff actually arrives wondering, in
 * the order they wonder them. Every answer matches what the product does
 * today: invitation-only accounts, IT-held password resets (the same line the
 * login page gives), the BFF boundary, per-project permission resolution, and
 * the mobile nav that already ships in the app shell.
 *
 * No question here is answered with "contact us" — the footer's support link
 * is still a placeholder, and pointing at it would be sending people nowhere.
 */
const QUESTIONS = [
  {
    get q() { return t('How do I get an account?'); },
    get a() { return t('Access is provisioned by IT — there is no sign-up on this page, and nothing to request inside {app} itself. Ask your manager or raise a request with the service desk; you will be invited by email and set your password from the link in it.', { app: APP_NAME }); },
  },
  {
    get q() { return t('I have an account but cannot sign in.'); },
    get a() { return t('Passwords are reset by IT support rather than from the login screen, so contact the service desk to regain access. If sign-in fails with your usual password still working elsewhere, say so when you raise it — it is usually the account, not the password.'); },
  },
  {
    get q() { return t('Does {app} replace the tools we already use?', { app: APP_NAME }); },
    get a() { return t('No. {app} is the single picture over the delivery record: it reads and writes the same projects, work packages and time entries your existing project tooling holds, so nothing has to be migrated and no team has to update two places.', { app: APP_NAME }); },
  },
  {
    get q() { return t('Does any of our data leave the company?'); },
    get a() { return t('Only through services your administrators switch on. {app} runs on {org} infrastructure, and your browser only ever talks to the {app} backend — it is never given an upstream address, an API token or a credential. What goes further: a question you ask Pragnya, with the records it reads to answer it, goes to the AI service in the region your administrators chose; email goes through the mail service they set up; and automation rules call only the addresses they allow. No password or token is kept in your browser, and the pages it caches for speed are cleared when you sign out.', { app: APP_NAME, org: ORG_NAME }); },
  },
  {
    get q() { return t('What will I be able to see?'); },
    get a() { return t('What your role and project membership allow, and nothing beyond it. Permissions are resolved per project and checked on every request, so a link to a project you are not on does not open it — including links shared by someone who can.'); },
  },
  {
    get q() { return t('Can I use it on my phone?'); },
    get a() { return t('Yes. {app} is one responsive app rather than a desktop site with a cut-down mobile version: the same screens, with navigation that moves to a bottom bar on small screens. There is no separate app to install.', { app: APP_NAME }); },
  },
];

/**
 * The questions the page would otherwise leave someone to guess at.
 *
 * Built as a disclosure list here rather than on a shared accordion: the app
 * has no accordion primitive, and adding one for a single public page would
 * put a component into the design system that nothing signed-in uses. It is a
 * button, `aria-expanded`, and a labelled region — the whole contract.
 *
 * One panel open at a time. With six answers of this length, letting them all
 * open turns the section into four screens of prose and loses the list.
 */
export function FaqSection() {
  const { reveal } = useLandingMotion();
  const reduceMotion = useReducedMotion();
  const baseId = useId();
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section id="faq" className="relative scroll-mt-24 overflow-hidden px-6 pb-28 md:pb-40">
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[minmax(0,22rem)_1fr] lg:gap-16">
        {/* The heading holds its own column on a wide screen so the answers
            keep a readable measure instead of running the full 72rem. */}
        <motion.div {...reveal(0, 0.7, { y: 30 })} className="lg:sticky lg:top-32 lg:self-start">
          <p className="text-xs uppercase tracking-widest text-white/40">{t('Questions')}</p>
          {/* Balanced: the heading column is 22rem and "Before you sign"
              overruns it, which breaks the line mid-phrase. */}
          <h2 className="mt-4 text-balance text-3xl tracking-tight text-white md:text-5xl">
            {t('Before you sign in')}
          </h2>
          <p className="mt-6 text-sm leading-relaxed text-white/50">
            {t('Everything here is how {app} works today, not what is planned.', { app: APP_NAME })}
          </p>
        </motion.div>

        <motion.ul {...reveal(0.1, 0.8, { y: 30 })} className="min-w-0">
          {QUESTIONS.map((item, index) => {
            const open = openIndex === index;
            const panelId = `${baseId}-faq-panel-${index}`;
            const buttonId = `${baseId}-faq-button-${index}`;

            return (
              <li key={item.q} className="border-b border-white/[0.07] first:border-t">
                <h3>
                  <button
                    type="button"
                    id={buttonId}
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => setOpenIndex(open ? null : index)}
                    className="flex w-full items-start justify-between gap-6 py-6 text-start transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 md:py-7"
                  >
                    <span className="font-display text-base font-medium tracking-tight text-white md:text-lg">
                      {item.q}
                    </span>
                    {/* One glyph for both states: a plus that becomes a minus
                        on the turn. Two icons swapping would flicker on the
                        frame they cross over. */}
                    <motion.span
                      aria-hidden
                      animate={reduceMotion ? undefined : { rotate: open ? 135 : 0 }}
                      transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
                      className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/[0.06] text-white/70"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </motion.span>
                  </button>
                </h3>

                <AnimatePresence initial={false}>
                  {open ? (
                    <motion.div
                      key="panel"
                      id={panelId}
                      role="region"
                      aria-labelledby={buttonId}
                      initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
                      className="overflow-hidden"
                    >
                      <p className="max-w-2xl pb-7 pe-10 text-sm leading-relaxed text-white/55">
                        {item.a}
                      </p>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </li>
            );
          })}
        </motion.ul>
      </div>
    </section>
  );
}
