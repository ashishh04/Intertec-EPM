import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { featureFlags } from '@/config/env';
import { SHORTCUT_GROUPS, formatKeys, isMacPlatform } from '@/config/shortcuts';

/**
 * The keyboard shortcuts reference.
 *
 * It exists because a product with shortcuts and no list of them has shortcuts
 * only for the person who built it. Everything here comes from the registry the
 * handlers publish to, so this cannot advertise a key that is not bound — the
 * usual fate of a help page maintained by hand.
 *
 * Keys are written for the platform they will be pressed on: ⌘ on a Mac, Ctrl
 * elsewhere. `<kbd>` rather than styled spans, because that is what the element
 * is for and it is what a screen reader announces as a key.
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mac = isMacPlatform();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            {mac ? '⌘ is Command.' : 'Ctrl is Control.'} Shortcuts that need the cursor out of a
            field say so.
          </DialogDescription>
        </DialogHeader>

        <div className="epm-dialog-body space-y-5 pb-4">
          {SHORTCUT_GROUPS.map((group) => {
            const shortcuts = group.shortcuts.filter(
              (shortcut) => !shortcut.flag || featureFlags[shortcut.flag],
            );
            if (shortcuts.length === 0) return null;

            return (
              <section key={group.title} className="space-y-1.5">
                <h3 className="epm-eyebrow">{group.title}</h3>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {shortcuts.map((shortcut) => (
                    <li
                      key={shortcut.label}
                      className="flex items-start justify-between gap-4 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-xs">{shortcut.label}</p>
                        {shortcut.detail ? (
                          <p className="text-2xs text-muted-foreground">{shortcut.detail}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {formatKeys(shortcut.keys, mac).map((key) => (
                          <kbd
                            key={key}
                            className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-2xs leading-none text-foreground"
                          >
                            {key}
                          </kbd>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
