import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { DoorOpen, ShieldCheck } from 'lucide-react';

import { GATE_STATUS } from '@/components/requests/requestMeta';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useProjects } from '@/hooks/useProjects';
import { useProjectGates, useStageGateMutations } from '@/hooks/useRequests';
import { t } from '@/lib/i18n';
import { formatShortDate } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { ID, ProjectGate } from '@/types';

const gateKey = (gate: Pick<ProjectGate, 'definitionId' | 'gate'>) => `${gate.definitionId}:${gate.gate}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : undefined);

/**
 * The gates of a project's life cycle, each passed through an approval chain:
 * where each stands, and asking for one to be reviewed.
 */
export function StageGatesCard({ projectId }: { projectId: ID }) {
  const gates = useProjectGates(projectId);
  const [asking, setAsking] = useState<ProjectGate>();

  return (
    <Card>
      <CardHeader variant="compact" className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('Stage gates')}
        </CardTitle>
        <p className="text-2xs text-muted-foreground">
          {t('Each gate between phases is passed through an approval. Passing one does not start the next phase by itself.')}
        </p>
      </CardHeader>
      <CardContent className="pt-3">
        {gates.isLoading ? (
          <Skeleton className="h-16 rounded-md" />
        ) : (gates.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('This project’s life cycle has no gates.')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {(gates.data ?? []).map((gate) => (
              <li key={gateKey(gate)} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-xs font-medium">
                    <DoorOpen className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    <span dir="auto">{gate.gateName}</span>
                  </p>
                  <p className="text-2xs text-muted-foreground">
                    {gate.gate === 'start' ? t('Opens {phase}', { phase: gate.phaseName }) : t('Closes {phase}', { phase: gate.phaseName })}
                    {gate.review?.decidedAt ? ` · ${formatShortDate(gate.review.decidedAt)}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {gate.review ? (
                    <Link to={`/stage-gate-reviews/${gate.review.id}`}>
                      <Badge size="sm" tone={GATE_STATUS[gate.review.status].tone}>
                        {GATE_STATUS[gate.review.status].label()}
                      </Badge>
                    </Link>
                  ) : (
                    <Badge size="sm" tone="neutral">
                      {t('Not reviewed')}
                    </Badge>
                  )}
                  {gate.canRequest ? (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-2xs" onClick={() => setAsking(gate)}>
                      {gate.review?.status === 'rejected' ? t('Ask again') : t('Request approval')}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <GateReviewDialog open={Boolean(asking)} onOpenChange={(open) => !open && setAsking(undefined)} projectId={projectId} gate={asking} />
    </Card>
  );
}

/**
 * Asks for a gate to be reviewed. With a project and gate given it asks for
 * that one; without, it lets the reader choose a project they manage and one
 * of its gates (the Create menu's way in).
 */
export function GateReviewDialog({
  open,
  onOpenChange,
  projectId: fixedProject,
  gate: fixedGate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: ID;
  gate?: ProjectGate;
}) {
  const navigate = useNavigate();
  const { canInProject } = useAuth();
  const projects = useProjects();
  const [projectId, setProjectId] = useState<ID | undefined>(fixedProject);
  const [chosen, setChosen] = useState<string>();
  const [notes, setNotes] = useState('');
  const [problem, setProblem] = useState<string>();
  const gates = useProjectGates(fixedGate ? undefined : projectId);
  const { request } = useStageGateMutations();

  useEffect(() => {
    if (!open) return;
    setProjectId(fixedProject);
    setChosen(fixedGate ? gateKey(fixedGate) : undefined);
    setNotes('');
    setProblem(undefined);
  }, [open, fixedProject, fixedGate]);

  const managed = (projects.data ?? []).filter((project) => canInProject(project.id, 'project:edit'));
  const askable = (gates.data ?? []).filter((gate) => gate.canRequest);
  const gate = fixedGate ?? askable.find((one) => gateKey(one) === chosen);

  const submit = () => {
    if (!projectId || !gate) return setProblem(t('Choose the project and the gate.'));
    request.mutate(
      { projectId, definitionId: gate.definitionId, gate: gate.gate, ...(notes.trim() ? { notes: notes.trim() } : {}) },
      {
        onSuccess: (review) => {
          toast.success(t('Gate review submitted for approval'), { description: review.key });
          onOpenChange(false);
          if (!fixedProject) navigate(`/stage-gate-reviews/${review.id}`);
        },
        onError: (error) => setProblem(errorText(error) ?? t('That could not be changed')),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Request gate approval')}</DialogTitle>
          <DialogDescription>{t('Say what has been done and what shows the project is ready to pass the gate.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          {fixedGate ? (
            <p className="text-sm">
              <span className="font-medium" dir="auto">
                {fixedGate.gateName}
              </span>
              <span className="text-muted-foreground"> · {fixedGate.phaseName}</span>
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="gate-project" required>
                  {t('Project')}
                </Label>
                <Select value={projectId} onValueChange={(value) => { setProjectId(value); setChosen(undefined); }}>
                  <SelectTrigger id="gate-project">
                    <SelectValue placeholder={t('Select a project')} />
                  </SelectTrigger>
                  <SelectContent>
                    {managed.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gate-gate" required>
                  {t('Gate')}
                </Label>
                <Select value={chosen} onValueChange={setChosen} disabled={!projectId || gates.isLoading}>
                  <SelectTrigger id="gate-gate">
                    <SelectValue placeholder={projectId && !gates.isLoading && askable.length === 0 ? t('No gate is waiting to be reviewed') : t('Choose a gate')} />
                  </SelectTrigger>
                  <SelectContent>
                    {askable.map((one) => (
                      <SelectItem key={gateKey(one)} value={gateKey(one)}>
                        {`${one.gateName} · ${one.phaseName}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="gate-notes">{t('The case for passing it')}</Label>
            <Textarea id="gate-notes" rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button loading={request.isPending} onClick={submit}>
            {t('Submit for approval')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
