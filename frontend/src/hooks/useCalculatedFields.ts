import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { calculatedFieldService } from '@/services';
import type { CalculatedFieldInput, CalculatedResultType, ID } from '@/types';

/**
 * Calculated fields (BR-406 to BR-408). A definition's values are worked out
 * by EPM after it is saved, and its column appears in every view, so saving
 * one refreshes the task lists and views too.
 */

const KEYS = {
  all: ['calculated-fields'] as const,
  list: () => ['calculated-fields', 'list'] as const,
  reference: () => ['calculated-fields', 'reference'] as const,
  status: () => ['calculated-fields', 'status'] as const,
  validation: (body: object) => ['calculated-fields', 'validation', body] as const,
  values: (id: ID) => ['calculated-fields', 'values', id] as const,
};

/** What a saved definition can change: the fields, and every list that shows them. */
const AFFECTED = [KEYS.all, ['tasks'], ['queries'], ['catalog', 'work-package-options']] as const;

function useRefreshAfterSave() {
  const client = useQueryClient();
  return () => {
    for (const key of AFFECTED) void client.invalidateQueries({ queryKey: key });
  };
}

export function useCalculatedFields(enabled = true) {
  return useQuery({ queryKey: KEYS.list(), queryFn: () => calculatedFieldService.list(), enabled, staleTime: 30_000 });
}

export function useFormulaReference(enabled = true) {
  return useQuery({ queryKey: KEYS.reference(), queryFn: () => calculatedFieldService.reference(), enabled, staleTime: 60_000 });
}

/** The last passes. Polled gently while one is pending, so the page shows it finish. */
export function useCalculatedStatus(enabled = true) {
  return useQuery({
    queryKey: KEYS.status(),
    queryFn: () => calculatedFieldService.status(),
    enabled,
    refetchInterval: (query) => (query.state.data?.pending ? 2_000 : 30_000),
  });
}

/** The value after it has stopped changing for `ms`. */
export function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * A formula checked as it is typed: the request is sent once typing pauses,
 * and the last answer stays on screen while the next is on its way.
 */
export function useFormulaValidation(body: {
  id?: ID;
  key?: string;
  name?: string;
  resultType: CalculatedResultType;
  expression: string;
  projectIds?: ID[];
  typeIds?: ID[];
  workPackageId?: ID;
}, enabled = true) {
  // Compared as text: a body is a new object on every render.
  const text = JSON.stringify(body);
  const settledText = useSettled(text);
  const settled = useMemo(() => JSON.parse(settledText) as typeof body, [settledText]);
  const query = useQuery({
    queryKey: KEYS.validation(settled),
    queryFn: () => calculatedFieldService.validate(settled),
    enabled: enabled && settled.expression.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    retry: false,
  });
  /** The answer is for exactly what is typed now — not an earlier version still on screen. */
  const current = settledText === text && !query.isFetching && !query.isPlaceholderData;
  return { ...query, current };
}

export function useSaveCalculatedField() {
  const refresh = useRefreshAfterSave();
  return useMutation({
    mutationFn: ({ id, input }: { id?: ID; input: CalculatedFieldInput }) =>
      id ? calculatedFieldService.update(id, input) : calculatedFieldService.create(input),
    onSuccess: refresh,
  });
}

export function useSetCalculatedFieldActive() {
  const refresh = useRefreshAfterSave();
  return useMutation({
    mutationFn: ({ id, active }: { id: ID; active: boolean }) => calculatedFieldService.setActive(id, active),
    onSuccess: refresh,
  });
}

export function useDeleteCalculatedField() {
  const refresh = useRefreshAfterSave();
  return useMutation({ mutationFn: (id: ID) => calculatedFieldService.remove(id), onSuccess: refresh });
}

export function useRecalculateCalculatedFields() {
  const refresh = useRefreshAfterSave();
  return useMutation({ mutationFn: () => calculatedFieldService.recalculate(), onSuccess: refresh });
}

/** One work package's calculated values. */
export function useWorkPackageCalculatedValues(id: ID | undefined) {
  return useQuery({
    queryKey: KEYS.values(id ?? ''),
    queryFn: () => calculatedFieldService.workPackageValues(id!),
    enabled: Boolean(id),
    staleTime: 15_000,
  });
}
