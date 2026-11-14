import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { LayoutGrid, Plus, RotateCcw, Settings2 } from 'lucide-react';

import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AddWidgetDialog, WidgetFrame } from '@/components/dashboard/WidgetFrame';
import { WIDGETS_BY_ID, isAvailable, isUntouchedLayout, roleLayout } from '@/components/dashboard/widgets';
import { usePreferences } from '@/hooks/usePreferences';
import { useAuth } from '@/providers/AuthProvider';
import { cn, formatLongDate, greetingForHour } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { DashboardWidgetPlacement, DashboardWidgetWidth } from '@/types';

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.045 } } };
const rise = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.32, 0.72, 0, 1] as const } },
};

/**
 * Overview — the page the person arranged.
 *
 * The layout is a preference, so it follows them between browsers and devices
 * rather than living in this tab's storage. Every widget fetches its own data,
 * which is what makes removing one worth doing: an Overview with three widgets
 * costs three widgets' worth of requests, not the full page's.
 *
 * A saved layout naming a widget this build does not have is skipped rather than
 * erased. A layout written by a newer frontend therefore survives a rollback,
 * and retiring a widget does not require touching anybody's stored settings.
 * So is a widget the person may not use, which keeps their layout intact for
 * the day they may.
 *
 * Until someone arranges it, the Overview is their role's: an administrator,
 * a manager, HR and an employee each start from what their work needs, and it
 * follows the role if that changes (widgets.tsx, ROLE_LAYOUTS).
 */
export default function DashboardPage() {
  const { user, role, can } = useAuth();
  const { preferences, update } = usePreferences();

  const [customising, setCustomising] = useState(false);
  const [adding, setAdding] = useState(false);

  const access = useMemo(() => ({ role, can }), [role, can]);
  const saved = preferences.dashboard.widgets;
  const placements = useMemo(() => (isUntouchedLayout(saved) ? roleLayout(role) : saved), [saved, role]);

  /** Placements that resolve to a widget this build knows and this person may use, in saved order. */
  const resolved = useMemo(
    () =>
      placements.flatMap((placement) => {
        const widget = WIDGETS_BY_ID.get(placement.id);
        return widget && isAvailable(widget, access) ? [{ placement, widget }] : [];
      }),
    [placements, access],
  );

  // Edits name the widget, not its position: the saved layout can hold widgets
  // that are not drawn, so a position on screen is not a position in the list.
  const visibleIds = resolved.map(({ placement }) => placement.id);

  const save = (next: DashboardWidgetPlacement[]) => update('dashboard', 'widgets', next);

  const move = (id: string, direction: -1 | 1) => {
    const neighbour = visibleIds[visibleIds.indexOf(id) + direction];
    if (neighbour === undefined) return;
    const next = [...placements];
    const from = next.findIndex((placement) => placement.id === id);
    const to = next.findIndex((placement) => placement.id === neighbour);
    // Destructured swap rather than a splice pair: one statement, and it cannot
    // leave the array short if the second half is ever edited away.
    [next[from], next[to]] = [next[to]!, next[from]!];
    save(next);
  };

  const setWidth = (id: string, width: DashboardWidgetWidth) =>
    save(placements.map((placement) => (placement.id === id ? { ...placement, width } : placement)));

  const remove = (id: string) => save(placements.filter((placement) => placement.id !== id));

  const add = (id: string) => save([...placements, { id }]);

  const reset = () => {
    save(roleLayout(role));
    toast.success(t('Overview reset to the default layout'));
  };

  const firstName = user?.name?.split(' ')[0];

  return (
    <div className="space-y-7">
      <PageHeader
        title={
          firstName === undefined
            ? t('{greeting}, there.', { greeting: greetingForHour() })
            : t('{greeting}, {name}.', { greeting: greetingForHour(), name: firstName })
        }
        description={
          customising
            ? t('Add, remove, resize and reorder. Changes save as you make them.')
            : t('Here\'s what needs your attention today.')
        }
        actions={
          <>
            {customising ? (
              <>
                <Button variant="secondary" onClick={() => setAdding(true)}>
                  <Plus className="h-4 w-4" />
                  {t('Add widget')}
                </Button>
                <Button variant="ghost" onClick={reset}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('Reset')}
                </Button>
                <Button onClick={() => setCustomising(false)}>{t('Done')}</Button>
              </>
            ) : (
              <>
                <div className="hidden text-end sm:block">
                  <p className="epm-eyebrow">{t('Today')}</p>
                  <p className="font-mono text-xs font-medium text-foreground">
                    {formatLongDate(new Date())}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => setCustomising(true)}>
                  <Settings2 className="h-3.5 w-3.5" />
                  {t('Customise')}
                </Button>
                {/* No Create button of the page's own: the header's Create, on
                    every page, already starts a task and everything else. A
                    second one here, creating only a task, read as the same
                    button doing something different. */}
              </>
            )}
          </>
        }
      />

      {resolved.length === 0 ? (
        <Card>
          <EmptyState
            icon={LayoutGrid}
            title={t('Your Overview is empty')}
            description={t('Add the widgets you want to see. Nothing is fetched for a widget that is not on the page.')}
            action={{
              label: t('Add the widgets for your role'),
              onClick: () => {
                save(roleLayout(role));
                toast.success(t('Added the widgets for your role'));
              },
            }}
          />
        </Card>
      ) : (
        /*
         * Two columns on large screens, one below. A full-width widget spans
         * both; a half-width one takes one. `items-start` matters: without it
         * every widget in a row stretches to the tallest, so a three-row
         * activity feed beside project health became a mostly empty card.
         */
        <motion.div
          variants={stagger}
          initial="hidden"
          animate="show"
          className={cn('grid items-start gap-5', 'lg:grid-cols-2')}
        >
          {resolved.map(({ placement, widget }, index) => {
            const width = placement.width ?? widget.defaultWidth;
            const { Component } = widget;

            if (customising) {
              return (
                <WidgetFrame
                  key={placement.id}
                  widget={widget}
                  width={width}
                  first={index === 0}
                  last={index === resolved.length - 1}
                  onMove={(direction) => move(placement.id, direction)}
                  onWidth={
                    widget.resizable
                      ? () => setWidth(placement.id, width === 'full' ? 'half' : 'full')
                      : undefined
                  }
                  onRemove={() => remove(placement.id)}
                >
                  <Component />
                </WidgetFrame>
              );
            }

            return (
              <motion.div
                key={placement.id}
                variants={rise}
                className={cn('min-w-0', width === 'full' && 'lg:col-span-2')}
              >
                <Component />
              </motion.div>
            );
          })}
        </motion.div>
      )}

      <AddWidgetDialog
        open={adding}
        onOpenChange={setAdding}
        present={placements.map((placement) => placement.id)}
        access={access}
        onAdd={add}
      />
    </div>
  );
}
