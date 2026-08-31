import { Toaster as SonnerToaster, toast } from 'sonner';
import { useTheme } from '@/providers/ThemeProvider';

/** App-wide toast surface, themed with the Nexus tokens. */
function Toaster() {
  const { resolvedTheme } = useTheme();

  return (
    <SonnerToaster
      theme={resolvedTheme}
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
