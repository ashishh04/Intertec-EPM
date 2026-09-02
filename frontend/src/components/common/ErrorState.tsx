import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
  size?: 'inline' | 'default';
}

/** Polished failure state. Never leave the user looking at a blank region. */
function ErrorState({
  title = 'Something went wrong',
  description = 'We could not load this content. Try again, and if the problem continues contact the EPM platform team.',
  onRetry,
  className,
  size = 'default',
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'default' ? 'gap-3 px-6 py-12' : 'gap-2 px-4 py-8',
        className,
      )}
    >
      <span
        className="flex h-10 w-10 items-center justify-center rounded-full bg-danger-soft text-danger"
        aria-hidden
      >
        <AlertCircle className="h-5 w-5" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mx-auto max-w-sm text-xs text-muted-foreground">{description}</p>
      </div>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry} className="mt-1">
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

interface BoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
}

interface BoundaryState {
  error: Error | null;
}

/** Catches render-time failures so one broken widget cannot blank the app. */
class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // A real deployment forwards this to the EPM observability pipeline.
    console.error('EPM render error', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          title={this.props.fallbackTitle ?? 'This section could not be displayed'}
          description={this.state.error.message}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

export { ErrorState, ErrorBoundary };
