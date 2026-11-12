import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRight, Layers3 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useProgramMutations, usePrograms } from '@/hooks/useProjectSettings';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmProject } from '@/types';

const NONE = '__none__';

/** The program the project is run in, changeable by whoever manages portfolios. */
export function ProjectProgramCard({ project }: { project: EpmProject }) {
  const { can } = useAuth();
  const mayManage = can('programs:manage') || can('portfolios:manage');
  const programs = usePrograms();
  const { setProjectProgram } = useProgramMutations();

  if (!mayManage && !project.programId) return null;

  return (
    <Card>
      <CardHeader variant="compact" className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <Layers3 className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Program')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-4">
        {/* Whoever can change it sees the program in the picker below, so
            the name is not repeated above it. */}
        {mayManage ? null : project.programId ? (
          <Link to={`/programs/${project.programId}`} className="text-sm hover:underline" dir="auto">
            {project.programName ?? t('Program')}
          </Link>
        ) : null}
        {mayManage && !project.programId ? (
          <p className="text-xs text-muted-foreground">{t('This project is not in a program.')}</p>
        ) : null}
        {mayManage ? (
          <Select
            value={project.programId ?? NONE}
            disabled={programs.isLoading || setProjectProgram.isPending}
            onValueChange={(value) =>
              setProjectProgram.mutate(
                { projectId: project.id, programId: value === NONE ? null : value },
                {
                  onSuccess: () => toast.success(value === NONE ? t('Project taken out of the program') : t('Project added to the program')),
                  onError: (error) => toast.error(t('That could not be changed'), { description: error instanceof Error ? error.message : undefined }),
                },
              )
            }
          >
            <SelectTrigger className="h-8 text-xs" aria-label={t('Change program')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('Not in a program')}</SelectItem>
              {(programs.data ?? [])
                .filter((program) => program.active || program.id === project.programId)
                .map((program) => (
                  <SelectItem key={program.id} value={program.id}>
                    {program.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : null}
        {mayManage && project.programId ? (
          <Link to={`/programs/${project.programId}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            {t('Open the program')}
            <ArrowRight className="h-3 w-3 rtl:rotate-180" aria-hidden />
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
