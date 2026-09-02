import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormResult } from '@/services/api/forms';

/**
 * Drives a form whose fields come from OpenProject rather than from us.
 *
 * The payload is echoed back to the Form endpoint as the user types, so
 * validation, defaulting and dependent-field behaviour (changing a type
 * rewrites which fields exist) all come from OpenProject. Nothing about
 * OpenProject's rules is restated on the client, which is the only way this
 * stays correct as an instance is reconfigured.
 */

const REVALIDATE_DELAY_MS = 400;

export interface SchemaFormState {
  form?: FormResult;
  /** Values the user has actually touched, merged over the server payload. */
  draft: Record<string, unknown>;
  errors: Record<string, string>;
  isLoading: boolean;
  isValidating: boolean;
  canSubmit: boolean;
  error?: Error;
  setValue: (field: string, value: unknown) => void;
  /** Re-reads the form immediately, e.g. after a dependent field changes. */
  refresh: () => void;
  reset: () => void;
}

export function useSchemaForm(
  load: (payload: Record<string, unknown>) => Promise<FormResult>,
  options: { enabled?: boolean; initial?: Record<string, unknown> } = {},
): SchemaFormState {
  const { enabled = true, initial } = options;

  const [form, setForm] = useState<FormResult>();
  const [draft, setDraft] = useState<Record<string, unknown>>(initial ?? {});
  const [isLoading, setIsLoading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<Error>();

  // `load` is typically an inline arrow, so keeping it in a ref stops the
  // effect below from firing on every render of the parent.
  const loadRef = useRef(load);
  loadRef.current = load;

  const requestId = useRef(0);

  const run = useCallback(
    async (payload: Record<string, unknown>, kind: 'load' | 'validate') => {
      const id = ++requestId.current;
      kind === 'load' ? setIsLoading(true) : setIsValidating(true);

      try {
        const next = await loadRef.current(payload);
        // A slower earlier request must not overwrite a newer result.
        if (id !== requestId.current) return;
        setForm(next);
        setError(undefined);
      } catch (cause) {
        if (id !== requestId.current) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        if (id === requestId.current) {
          setIsLoading(false);
          setIsValidating(false);
        }
      }
    },
    [],
  );

  // Initial load.
  useEffect(() => {
    if (!enabled) return;
    void run(initial ?? {}, 'load');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run]);

  // Debounced revalidation as the draft changes.
  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    if (!enabled || !form) return;
    const timer = setTimeout(() => void run(draft, 'validate'), REVALIDATE_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, enabled]);

  const setValue = useCallback((field: string, value: unknown) => {
    setDraft((current) => ({ ...current, [field]: value }));
  }, []);

  const refresh = useCallback(() => void run(draft, 'validate'), [draft, run]);

  const reset = useCallback(() => {
    setDraft(initial ?? {});
    void run(initial ?? {}, 'load');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const errors = form?.errors ?? {};

  // OpenProject withholds the commit link while the payload is invalid, so it
  // is a more trustworthy gate than anything we could compute.
  const canSubmit = Boolean(form?.commit) && Object.keys(errors).length === 0;

  const merged = useMemo(() => ({ ...(form?.payload ?? {}), ...draft }), [form?.payload, draft]);

  return {
    form,
    draft: merged,
    errors,
    isLoading,
    isValidating,
    canSubmit,
    error,
    setValue,
    refresh,
    reset,
  };
}
