import { useState } from 'react';
import { ListChecks, Pencil } from 'lucide-react';

import { ProjectDialog } from '@/components/common/ProjectDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useProjectAttributes } from '@/hooks/useProjectSettings';
import { formatShortDate } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { ProjectAttribute } from '@/types';

/** A value as the reader expects it: dates in their format, yes and no in words. */
function display(field: ProjectAttribute): string {
  if (field.value === undefined) return '—';
  if (field.format === 'bool') return field.value === 'true' ? t('Yes') : t('No');
  if (field.format === 'date') return formatShortDate(field.value);
  return field.value;
}

/**
 * The project's attributes, by section, with their values here; Edit opens
 * the project form on them alone. Nothing at all when the organisation has
 * defined none, or this project shows none.
 */
export function ProjectAttributesCard({ projectId }: { projectId: string }) {
  const attributes = useProjectAttributes(projectId);
  const [editing, setEditing] = useState(false);
  const sections = (attributes.data?.sections ?? [])
    .map((section) => ({ ...section, fields: section.fields.filter((field) => field.enabled) }))
    .filter((section) => section.fields.length > 0);

  if (attributes.isLoading) return <Skeleton className="h-32 w-full rounded-lg" />;
  if (sections.length === 0) return null;

  return (
    <Card>
      <CardHeader
        variant="compact"
        actions={
          attributes.data?.canEdit ? (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
              {t('Edit')}
            </Button>
          ) : null
        }
      >
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Project attributes')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        {sections.map((section) => (
          <section key={section.id} className="space-y-2">
            {sections.length > 1 ? <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{section.name}</h3> : null}
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {section.fields.map((field) => (
                <div key={field.id} className="min-w-0">
                  <dt className="epm-eyebrow">{field.name}</dt>
                  <dd className="mt-0.5 break-words text-sm" dir="auto">
                    {field.format === 'link' && field.value ? (
                      <a href={field.value} target="_blank" rel="noreferrer noopener" className="text-primary underline-offset-2 hover:underline" dir="ltr">
                        {field.value}
                      </a>
                    ) : (
                      display(field)
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </CardContent>
      <ProjectDialog open={editing} onOpenChange={setEditing} projectId={projectId} fields="attributes" />
    </Card>
  );
}
