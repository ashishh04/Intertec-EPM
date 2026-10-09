import { useMemo, useState } from 'react';

import { MultiSelect } from '@/components/common/MultiSelect';
import { DEFAULT_COLUMNS } from '@/components/portfolios/PortfolioOverviewPanel';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useMeasureCatalogue } from '@/hooks/useInsights';
import { usePortfolios } from '@/hooks/usePortfolios';
import { usePortfolioViewOptions } from '@/hooks/usePortfolioViews';
import { useProjects } from '@/hooks/useProjects';
import { PERIODS } from '@/lib/report-periods';
import { cn } from '@/lib/utils';
import type { HealthLevel, ID, PortfolioViewInput, PortfolioViewVisibility, ReportPeriodPreset } from '@/types';

/**
 * Saves a portfolio view (BR-203): which projects, at what health, over what
 * period and with which columns — and who else sees it. Sharing shares the
 * selection, never the projects: everyone sees the view with their own access.
 */

export function blankView(prefill?: { name?: string; portfolioIds?: ID[] }): PortfolioViewInput {
  return {
    name: prefill?.name ?? '',
    description: '',
    visibility: 'private',
    roleIds: [],
    definition: {
      portfolioIds: prefill?.portfolioIds ?? [],
      projectIds: [],
      health: [],
      periodPreset: 'last-12-weeks',
      columns: [...DEFAULT_COLUMNS],
    },
  };
}

const HEALTH: { id: HealthLevel; label: string }[] = [
  { id: 'healthy', label: 'Green' },
  { id: 'warning', label: 'Amber' },
  { id: 'critical', label: 'Red' },
];

const SHARING: { id: PortfolioViewVisibility; label: string; hint: string }[] = [
  { id: 'private', label: 'Only me', hint: 'Nobody else sees it.' },
  { id: 'roles', label: 'People in roles', hint: 'Anyone holding one of the roles on a project in the view.' },
  { id: 'public', label: 'Everyone', hint: 'Anyone who can sign in to EPM.' },
];

export function PortfolioViewDialog({
  id,
  initial,
  saving,
  onClose,
  onSave,
}: {
  id?: ID;
  initial: PortfolioViewInput;
  saving: boolean;
  onClose: () => void;
  onSave: (input: PortfolioViewInput) => void;
}) {
  const [draft, setDraft] = useState<PortfolioViewInput>(initial);
  const set = (patch: Partial<PortfolioViewInput>) => setDraft((was) => ({ ...was, ...patch }));
  const define = (patch: Partial<PortfolioViewInput['definition']>) =>
    setDraft((was) => ({ ...was, definition: { ...was.definition, ...patch } }));

  const portfolios = usePortfolios();
  const projects = useProjects();
  const options = usePortfolioViewOptions();
  const catalogue = useMeasureCatalogue();

  const portfolioOptions = useMemo(() => (portfolios.data ?? []).map((item) => ({ id: item.id, name: item.name })), [portfolios.data]);
  const projectOptions = useMemo(
    () => (projects.data ?? []).filter((item) => item.status !== 'paused').map((item) => ({ id: item.id, name: item.name })),
    [projects.data],
  );
  const roleOptions = options.data?.roles ?? [];
  const columnLabel = (column: string) =>
    column === 'health' ? 'Health' : (catalogue.data?.find((measure) => measure.id === column)?.label ?? column);
  const allColumns = options.data?.columns ?? DEFAULT_COLUMNS;

  const problems = [
    ...(draft.name.trim() ? [] : ['Give the view a name.']),
    ...(draft.definition.columns.length > 0 ? [] : ['Show at least one column.']),
    ...(draft.visibility === 'roles' && draft.roleIds.length === 0 ? ['Choose the roles it is shared with.'] : []),
  ];

  const toggleColumn = (column: string, on: boolean) =>
    define({
      // Kept in the order the overview lists them, whatever order they were ticked in.
      columns: allColumns.filter((one) => (one === column ? on : draft.definition.columns.includes(one))),
    });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{id ? 'Edit portfolio view' : 'Save a portfolio view'}</DialogTitle>
          <DialogDescription>
            A view keeps a selection of projects and how to show them. Sharing it never shares a project: everyone sees it with their own access.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[68vh] space-y-5 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="view-name" required>
                Name
              </Label>
              <Input
                id="view-name"
                value={draft.name}
                maxLength={120}
                onChange={(event) => set({ name: event.target.value })}
                placeholder="e.g. Board pack — delivery portfolios"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Period</Label>
              <Select value={draft.definition.periodPreset} onValueChange={(value) => define({ periodPreset: value as ReportPeriodPreset })}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIODS.map((period) => (
                    <SelectItem key={period.id} value={period.id}>
                      {period.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHint>For the figures that count a period: milestones due, work delivered.</FieldHint>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="view-description">Description</Label>
            <Textarea
              id="view-description"
              rows={2}
              maxLength={1000}
              value={draft.description ?? ''}
              onChange={(event) => set({ description: event.target.value })}
            />
          </div>

          <section className="space-y-2">
            <p className="text-xs font-semibold">Projects</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Portfolios</Label>
                <MultiSelect
                  label="Portfolios"
                  options={portfolioOptions}
                  selected={portfolioOptions.filter((item) => draft.definition.portfolioIds.includes(item.id))}
                  onChange={(selected) => define({ portfolioIds: selected.map((item) => item.id) })}
                  placeholder="None"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Projects</Label>
                <MultiSelect
                  label="Projects"
                  options={projectOptions}
                  selected={projectOptions.filter((item) => draft.definition.projectIds.includes(item.id))}
                  onChange={(selected) => define({ projectIds: selected.map((item) => item.id) })}
                  placeholder="None"
                />
              </div>
            </div>
            <FieldHint>
              The projects in those portfolios and those named — or every active project, if you choose none. A project
              someone cannot see is left out of their view, and they are told how many were.
            </FieldHint>
            <div className="flex flex-wrap items-center gap-4 pt-1">
              <span className="text-xs text-muted-foreground">Only at health</span>
              {HEALTH.map((level) => (
                <label key={level.id} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={draft.definition.health.includes(level.id)}
                    onCheckedChange={(on) =>
                      define({
                        health: on === true ? [...draft.definition.health, level.id] : draft.definition.health.filter((one) => one !== level.id),
                      })
                    }
                  />
                  {level.label}
                </label>
              ))}
              <FieldHint className="m-0">None ticked: any health.</FieldHint>
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold">Columns</p>
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-3">
              {allColumns.map((column) => (
                <label key={column} className="flex items-center gap-2 text-xs">
                  <Checkbox checked={draft.definition.columns.includes(column)} onCheckedChange={(on) => toggleColumn(column, on === true)} />
                  {columnLabel(column)}
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold">Shared with</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {SHARING.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => set({ visibility: option.id })}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors',
                    draft.visibility === option.id ? 'border-primary bg-primary-soft' : 'border-border hover:bg-muted',
                  )}
                  aria-pressed={draft.visibility === option.id}
                >
                  <span className="block text-xs font-semibold">{option.label}</span>
                  <span className="block text-2xs text-muted-foreground">{option.hint}</span>
                </button>
              ))}
            </div>
            {draft.visibility === 'roles' ? (
              <div className="space-y-1.5">
                <Label>Roles</Label>
                <MultiSelect
                  label="Roles"
                  options={roleOptions}
                  selected={roleOptions.filter((role) => draft.roleIds.includes(role.id))}
                  onChange={(selected) => set({ roleIds: selected.map((role) => role.id) })}
                  placeholder="Choose roles"
                />
              </div>
            ) : null}
          </section>

          {problems.length > 0 ? (
            <Alert tone="warning" title="Before it can be saved">
              <ul className="list-disc pl-4">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            loading={saving}
            disabled={problems.length > 0}
            onClick={() =>
              onSave({
                ...draft,
                name: draft.name.trim(),
                description: draft.description?.trim() || null,
                roleIds: draft.visibility === 'roles' ? draft.roleIds : [],
              })
            }
          >
            {id ? 'Save changes' : 'Save view'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
