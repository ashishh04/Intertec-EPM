import { Calculator } from 'lucide-react';

import { formatCalculatedValue } from '@/components/calculated/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useWorkPackageCalculatedValues } from '@/hooks/useCalculatedFields';
import { t } from '@/lib/i18n';
import { formatRelative } from '@/lib/utils';
import type { ID } from '@/types';

/**
 * This work package's calculated fields (BR-406): each value EPM worked out,
 * and — where there is none — why. Read-only: the values follow the work, and
 * nobody can type over one. Shown only when a field applies here.
 */
export function TaskCalculatedValues({ workPackageId }: { workPackageId: ID }) {
  const values = useWorkPackageCalculatedValues(workPackageId);
  const list = values.data ?? [];
  if (values.isError || list.length === 0) return null;
  const latest = list.reduce((max, value) => (value.updatedAt > max ? value.updatedAt : max), list[0]!.updatedAt);

  return (
    <Card data-testid="task-calculated-values">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <Calculator className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Calculated fields')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          {list.map((value) => (
            <div key={value.fieldId} className="min-w-0">
              <dt className="truncate text-2xs text-muted-foreground" dir="auto">
                {value.name}
              </dt>
              <dd className="font-medium text-foreground" dir="auto">
                {formatCalculatedValue(value.resultType, value.value)}
              </dd>
              {value.value === null && value.reason ? <dd className="text-2xs text-muted-foreground">{value.reason}</dd> : null}
            </div>
          ))}
        </dl>
        <p className="text-2xs text-muted-foreground">
          {t('Worked out by EPM {when}, from its formulas; they cannot be set by hand.', { when: formatRelative(latest) })}
        </p>
      </CardContent>
    </Card>
  );
}
