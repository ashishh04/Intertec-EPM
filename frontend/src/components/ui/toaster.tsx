import { Toaster as SonnerToaster, toast } from 'sonner';

/** App-wide toast surface, themed with the EPM tokens. */
function Toaster() {
  return (
    <SonnerToaster
      theme="light"
      position="bottom-right"
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
