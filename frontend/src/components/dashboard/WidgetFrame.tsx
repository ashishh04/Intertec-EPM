import { ArrowDown, ArrowUp, Maximize2, Minimize2, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EmptyState } from '@/components/common/EmptyState';
import { WIDGETS, type DashboardWidget } from './widgets';
import { cn } from '@/lib/utils';
import type { DashboardWidgetWidth } from '@/types';

/**
 * The customise-mode chrome around a widget.
 *
 * Reordering is buttons, not drag-and-drop, and deliberately. A dashboard is
 * arranged once and read a hundred times, so the cost of the interaction barely
 * matters while the cost of it being unusable does: move-up/move-down works from
 * the keyboard, works with a screen reader, works on a phone, and cannot drop a
 * widget somewhere the person did not mean. A drag handle would have needed all
 * four behaviours added back on top of it.
 */
export function WidgetFrame({
  widget,
  width,
  first,
  last,
  onMove,
  onWidth,
  onRemove,
  children,
}: {
  widget: DashboardWidget;
  width: DashboardWidgetWidth;
  first: boolean;
  last: boolean;
  onMove: (direction: -1 | 1) => void;
  /** Absent when the widget only works at one width. */
  onWidth?: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={widget.title}
      className={cn(
        'relative rounded-xl border border-dashed border-primary/40 bg-primary-soft/20 p-2',
        width === 'full' && 'lg:col-span-2',
      )}
    >
      <div className="mb-2 flex items-center gap-1.5">
        <widget.icon className="h-3.5 w-3.5 text-primary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-2xs font-medium text-primary">{widget.title}</p>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${widget.title} up`}
          disabled={first}
          onClick={() => onMove(-1)}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${widget.title} down`}
          disabled={last}
          onClick={() => onMove(1)}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        {onWidth ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              width === 'full'
                ? `Make ${widget.title} half width`
                : `Make ${widget.title} full width`
            }
            onClick={onWidth}
          >
            {width === 'full' ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${widget.title}`}
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* The widget itself stays live rather than becoming a placeholder: seeing
          the real content is how someone decides where it belongs. */}
      {children}
    </section>
  );
}

/**
 * Picks a widget to add.
 *
 * Only offers what is not already on the page — a widget cannot be in two
 * places, and the backend collapses duplicates anyway, so offering one would be
 * a control that appears to do nothing.
 */
export function AddWidgetDialog({
  open,
  onOpenChange,
  present,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  present: string[];
  onAdd: (id: string) => void;
}) {
  const taken = new Set(present);
  const available = WIDGETS.filter((widget) => !taken.has(widget.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a widget</DialogTitle>
          <DialogDescription>
            Everything not already on your Overview. It is added at the bottom, and you can move it
            from there.
          </DialogDescription>
        </DialogHeader>

        {available.length === 0 ? (
          <EmptyState
            size="inline"
            icon={Plus}
            title="Every widget is already on your Overview"
            description="Remove one to make room, or reorder what is there."
          />
        ) : (
          <ScrollArea className="max-h-96">
            <ul className="space-y-1.5 pr-3">
              {available.map((widget) => (
                <li key={widget.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onAdd(widget.id);
                      onOpenChange(false);
                    }}
                    className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary-soft/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                      <widget.icon className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">{widget.title}</span>
                      <span className="block text-2xs text-muted-foreground">
                        {widget.description}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
