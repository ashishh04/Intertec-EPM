import type { ReactNode } from 'react';
import { ErrorState } from './ErrorState';

interface QueryBoundaryProps {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Skeleton shown while the query is in flight. */
  skeleton: ReactNode;
  /** Rendered when the query succeeded but returned nothing. */
  isEmpty?: boolean;
  empty?: ReactNode;
  errorTitle?: string;
  children: ReactNode;
}

/**
 * Standard loading / error / empty ladder so every async surface behaves the
 * same way without repeating the branching in each page.
 */
function QueryBoundary({
  isLoading,
  isError,
  error,
  onRetry,
  skeleton,
  isEmpty,
  empty,
  errorTitle,
  children,
}: QueryBoundaryProps) {
  if (isLoading) return <>{skeleton}</>;

  if (isError) {
    return (
      <ErrorState
        title={errorTitle}
        description={error instanceof Error ? error.message : undefined}
        onRetry={onRetry}
      />
    );
  }

  if (isEmpty && empty) return <>{empty}</>;

  return <>{children}</>;
}

export { QueryBoundary };
