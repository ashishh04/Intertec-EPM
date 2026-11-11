import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Blocks, Copy, Flag, ListChecks } from 'lucide-react';

import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  useProjectAttributes,
  useProjectModules,
  useProjectPhases,
  useSetAttributeEnabled,
  useSetProjectModules,
  useSetProjectPhase,
  useSetTemplate,
} from '@/hooks/useProjectSettings';
import { useProject } from '@/hooks/useProjects';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';
import type { ProjectPhase } from '@/types';

/** The modules EPM has screens for, by the delivery system's own name, with what each brings. */
const MODULES: { name: string; label: () => string; hint: () => string }[] = [
  { name: 'work_package_tracking', label: () => t('Work packages'), hint: () => t('Tasks, the roadmap and everything planned as work.') },
  { name: 'board_view', label: () => t('Boards'), hint: () => t('The project’s boards.') },
  { name: 'backlogs', label: () => t('Backlogs and sprints'), hint: () => t('The backlog, sprint planning and the Sprint tab.') },
  { name: 'gantt', label: () => t('Gantt'), hint: () => t('The timeline of the project’s work.') },
  { name: 'calendar_view', label: () => t('Calendar'), hint: () => t('The project’s work by date.') },
  { name: 'costs', label: () => t('Time and costs'), hint: () => t('Logging time and costs against the project’s work.') },
  { name: 'budgets', label: () => t('Budgets'), hint: () => t('Budgets for the project’s costs.') },
  { name: 'documents', label: () => t('Documents'), hint: () => t('Files filed under the project.') },
  { name: 'meetings', label: () => t('Meetings'), hint: () => t('The Meetings tab.') },
  { name: 'news', label: () => t('News'), hint: () => t('The project’s announcements.') },
  { name: 'activity', label: () => t('Activity'), hint: () => t('The Activity tab: what changed, and when.') },
];

/**
 * A project's settings: which modules it uses, which project attributes it
 * shows, whether it is a template, and its life-cycle phases. Each switch
 * saves as it is flipped, refused with the reason when the person may not.
 */
export default function ProjectSettingsTab() {
  const { projectId } = useParams();
  const { can } = useAuth();
  const project = useProject(projectId);

  return (
    <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
      <div className="space-y-5">
        <ModulesCard projectId={projectId!} />
        <PhasesCard projectId={projectId!} />
      </div>
      <div className="space-y-5">
        <AttributesCard projectId={projectId!} />
        {can('users:manage') ? <TemplateCard projectId={projectId!} templated={Boolean(project.data?.templated)} /> : null}
      </div>
    </div>
  );
}

const failed = (what: string) => (error: unknown) => toast.error(what, { description: error instanceof Error ? error.message : undefined });

function ModulesCard({ projectId }: { projectId: string }) {
  const modules = useProjectModules(projectId);
  const save = useSetProjectModules(projectId);
  const enabled = new Set((modules.data?.modules ?? []).filter((module) => module.enabled).map((module) => module.name));
  const available = new Set((modules.data?.modules ?? []).map((module) => module.name));

  const toggle = (name: string, on: boolean) => {
    const next = new Set(enabled);
    if (on) next.add(name);
    else next.delete(name);
    // Modules EPM has no screen for keep whatever state they had.
    save.mutate([...next], { onSuccess: () => toast.success(on ? t('Module switched on') : t('Module switched off')), onError: failed(t('The module was not changed')) });
  };

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle className="flex items-center gap-2">
          <Blocks className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Modules')}
        </CardTitle>
        <CardDescription className="text-2xs">{t('What this project uses. A module switched off takes its tab away.')}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <QueryBoundary isLoading={modules.isLoading} isError={modules.isError} error={modules.error} onRetry={() => modules.refetch()} errorTitle={t('Unable to load the modules')} skeleton={<Skeleton className="m-4 h-40" />}>
          <ul className="divide-y divide-border">
            {MODULES.filter((module) => available.has(module.name)).map((module) => (
              <li key={module.name} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{module.label()}</p>
                  <p className="text-2xs text-muted-foreground">{module.hint()}</p>
                </div>
                <Switch
                  checked={enabled.has(module.name)}
                  disabled={!modules.data?.canEdit || save.isPending}
                  aria-label={module.label()}
                  onCheckedChange={(on) => toggle(module.name, on)}
                />
              </li>
            ))}
          </ul>
          {modules.data && !modules.data.canEdit ? <p className="px-4 pb-3 text-2xs text-muted-foreground">{t('Only someone who manages the project’s modules can change these.')}</p> : null}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function AttributesCard({ projectId }: { projectId: string }) {
  const attributes = useProjectAttributes(projectId);
  const setEnabled = useSetAttributeEnabled(projectId);
  const sections = attributes.data?.sections ?? [];

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Project attributes')}
        </CardTitle>
        <CardDescription className="text-2xs">{t('Which of the organisation’s project attributes this project shows. Their values are set on the Overview.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <QueryBoundary isLoading={attributes.isLoading} isError={attributes.isError} error={attributes.error} onRetry={() => attributes.refetch()} errorTitle={t('Unable to load the project attributes')} skeleton={<Skeleton className="h-32" />}>
          {sections.length === 0 ? (
            <p className="text-2xs text-muted-foreground">{t('The organisation has defined no project attributes yet. An administrator adds them under Administration → Projects → Project attributes.')}</p>
          ) : (
            sections.map((section) => (
              <section key={section.id} className="space-y-1.5">
                <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{section.name}</h3>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {section.fields.map((field) => (
                    <li key={field.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm" dir="auto">
                        {field.name}
                      </span>
                      {field.required ? <Badge tone="warning" size="sm">{t('Required')}</Badge> : null}
                      {field.forAll ? <Badge tone="neutral" size="sm">{t('Every project')}</Badge> : null}
                      <Switch
                        checked={field.enabled}
                        disabled={field.forAll || !attributes.data?.canSelect || setEnabled.isPending}
                        aria-label={t('Show {name} in this project', { name: field.name })}
                        onCheckedChange={(on) =>
                          setEnabled.mutate(
                            { customFieldId: field.id, enabled: on },
                            { onSuccess: () => toast.success(on ? t('Attribute shown') : t('Attribute hidden')), onError: failed(t('That could not be changed')) },
                          )
                        }
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

function TemplateCard({ projectId, templated }: { projectId: string; templated: boolean }) {
  const save = useSetTemplate(projectId);
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle className="flex items-center gap-2">
          <Copy className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Template')}
        </CardTitle>
        <CardDescription className="text-2xs">{t('A template is offered when someone creates a project, which then starts as a copy of it.')}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3 p-4 pt-0">
        <span className="flex-1 text-sm">{t('Use this project as a template')}</span>
        <Switch
          checked={templated}
          disabled={save.isPending}
          aria-label={t('Use this project as a template')}
          onCheckedChange={(on) =>
            save.mutate(on, { onSuccess: () => toast.success(on ? t('Now a template') : t('No longer a template')), onError: failed(t('That could not be changed')) })
          }
        />
      </CardContent>
    </Card>
  );
}

function PhasesCard({ projectId }: { projectId: string }) {
  const phases = useProjectPhases(projectId);
  const save = useSetProjectPhase(projectId);
  const data = phases.data;

  const change = (phase: ProjectPhase, input: { active?: boolean; startDate?: string | null; finishDate?: string | null }) =>
    save.mutate({ definitionId: phase.definitionId, input }, { onSuccess: () => toast.success(t('Life cycle saved')), onError: failed(t('The life cycle was not changed')) });

  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle className="flex items-center gap-2">
          <Flag className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Life cycle')}
        </CardTitle>
        <CardDescription className="text-2xs">{t('The phases the project goes through and the gates between them. Later phases move when an earlier one’s dates change.')}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <QueryBoundary isLoading={phases.isLoading} isError={phases.isError} error={phases.error} onRetry={() => phases.refetch()} errorTitle={t('Unable to load the life cycle')} skeleton={<Skeleton className="m-4 h-40" />}>
          <ol className="divide-y divide-border">
            {(data?.phases ?? []).map((phase) => (
              <li key={phase.definitionId} className="space-y-2 px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{phase.name}</p>
                    <p className="text-2xs text-muted-foreground">
                      {[phase.startGate ? t('Opens at: {gate}', { gate: phase.startGateName ?? '' }) : null, phase.finishGate ? t('Closes at: {gate}', { gate: phase.finishGateName ?? '' }) : null]
                        .filter(Boolean)
                        .join(' · ') || t('No gate')}
                    </p>
                  </div>
                  <Switch
                    checked={phase.active}
                    disabled={!data?.canSelect || save.isPending}
                    aria-label={t('Use the {phase} phase', { phase: phase.name })}
                    onCheckedChange={(on) => change(phase, { active: on })}
                  />
                </div>
                {phase.active ? (
                  // Keyed on the dates, so the inputs show what was saved, and what later phases moved to.
                  <div key={`${phase.startDate}|${phase.finishDate}`} className="grid grid-cols-2 gap-2">
                    <Input
                      type="date"
                      aria-label={t('{phase} starts', { phase: phase.name })}
                      defaultValue={phase.startDate ?? ''}
                      disabled={!data?.canEdit || save.isPending}
                      onBlur={(event) => event.target.value !== (phase.startDate ?? '') && change(phase, { startDate: event.target.value || null })}
                    />
                    <Input
                      type="date"
                      aria-label={t('{phase} finishes', { phase: phase.name })}
                      defaultValue={phase.finishDate ?? ''}
                      disabled={!data?.canEdit || save.isPending}
                      onBlur={(event) => event.target.value !== (phase.finishDate ?? '') && change(phase, { finishDate: event.target.value || null })}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
