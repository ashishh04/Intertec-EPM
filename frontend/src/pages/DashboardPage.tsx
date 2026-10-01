import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { LayoutGrid, Plus, RotateCcw, Settings2 } from 'lucide-react';

import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AddWidgetDialog, WidgetFrame } from '@/components/dashboard/WidgetFrame';
import { WIDGETS_BY_ID, SUGGESTED_WIDGET_IDS } from '@/components/dashboard/widgets';
import { DEFAULT_PREFERENCES, usePreferences } from '@/hooks/usePreferences';
import { useAuth } from '@/providers/AuthProvider';
import { useUI } from '@/providers/UIProvider';
import { cn, formatLongDate, greetingForHour } from '@/lib/utils';
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
 */
export default function DashboardPage() {
  const { user } = useAuth();
  const { openTaskDrawer } = useUI();
  const { preferences, update } = usePreferences();

  const [customising, setCustomising] = useState(false);
  const [adding, setAdding] = useState(false);

  const placements = preferences.dashboard.widgets;

  /** Placements that resolve to a widget this build knows, in saved order. */
  const resolved = useMemo(
    () =>
      placements.flatMap((placement) => {
        const widget = WIDGETS_BY_ID.get(placement.id);
        return widget ? [{ placement, widget }] : [];
      }),
    [placements],
  );

  const save = (next: DashboardWidgetPlacement[]) => update('dashboard', 'widgets', next);

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= placements.length) return;
    const next = [...placements];
    // Destructured swap rather than a splice pair: one statement, and it cannot
    // leave the array short if the second half is ever edited away.
    [next[index], next[target]] = [next[target]!, next[index]!];
    save(next);
  };

  const setWidth = (index: number, width: DashboardWidgetWidth) =>
    save(placements.map((placement, at) => (at === index ? { ...placement, width } : placement)));

  const remove = (index: number) => save(placements.filter((_, at) => at !== index));

  const add = (id: string) => save([...placements, { id }]);

  const reset = () => {
    save(DEFAULT_PREFERENCES.dashboard.widgets);
    toast.success('Overview reset to the default layout');
  };

  return (
    <div className="space-y-7">
      <PageHeader
        title={`${greetingForHour()}, ${user?.name?.split(' ')[0] ?? 'there'}.`}
        description={
          customising
            ? 'Add, remove, resize and reorder. Changes save as you make them.'
            : "Here's what needs your attention today."
        }
        actions={
          <>
            {customising ? (
              <>
                <Button variant="secondary" onClick={() => setAdding(true)}>
                  <Plus className="h-4 w-4" />
                  Add widget
                </Button>
                <Button variant="ghost" onClick={reset}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset
                </Button>
                <Button onClick={() => setCustomising(false)}>Done</Button>
              </>
            ) : (
              <>
                <div className="hidden text-right sm:block">
                  <p className="epm-eyebrow">Today</p>
                  <p className="font-mono text-xs font-medium text-foreground">
                    {formatLongDate(new Date())}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => setCustomising(true)}>
                  <Settings2 className="h-3.5 w-3.5" />
                  Customise
                </Button>
                <Button onClick={() => openTaskDrawer()}>
                  <Plus className="h-4 w-4" />
                  Create
                </Button>
              </>
            )}
          </>
        }
      />

      {resolved.length === 0 ? (
        <Card>
          <EmptyState
            icon={LayoutGrid}
            title="Your Overview is empty"
            description="Add the widgets you want to see. Nothing is fetched for a widget that is not on the page."
            action={{
              label: 'Add the usual four',
              onClick: () => {
                save(SUGGESTED_WIDGET_IDS.map((id) => ({ id })));
                toast.success('Added key metrics, My Work, project health and activity');
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
                  onMove={(direction) => move(index, direction)}
                  onWidth={
                    widget.resizable
                      ? () => setWidth(index, width === 'full' ? 'half' : 'full')
                      : undefined
                  }
                  onRemove={() => remove(index)}
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
        onAdd={add}
      />
    </div>
  );
}
