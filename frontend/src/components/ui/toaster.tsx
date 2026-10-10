import { Toaster as SonnerToaster, toast } from 'sonner';

import { direction, isRightToLeft, t } from '@/lib/i18n';

/**
 * App-wide toast surface, themed with the EPM tokens. Toasts sit in the corner
 * the page ends at — bottom right in English, bottom left in Arabic.
 */
function Toaster() {
  return (
    <SonnerToaster
      theme="light"
      dir={direction()}
      position={isRightToLeft() ? 'bottom-left' : 'bottom-right'}
      containerAriaLabel={t('Notifications')}
      offset={16}
      gap={8}
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'group rounded-xl border border-border bg-surface text-foreground shadow-elevated text-xs',
          title: 'text-xs font-semibold',
          description: 'text-2xs text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground rounded-md text-2xs',
          cancelButton: 'bg-muted text-muted-foreground rounded-md text-2xs',
          closeButton: 'border-border bg-surface text-muted-foreground',
          success: '[&_[data-icon]]:text-success',
          error: '[&_[data-icon]]:text-danger',
          warning: '[&_[data-icon]]:text-warning',
          info: '[&_[data-icon]]:text-primary',
        },
      }}
    />
  );
}

export { Toaster, toast };
