import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { dateOf, message, render, renderStored, type Message } from '../lib/i18n.js';
import { withAudit } from './audit.js';
import { isoOf } from './critical-path.js';
import { addWorkingDays, forecastProject, percentile, type Calendar, type ForecastModel, type ProjectForecast, type ProjectInput } from './forecasting.js';
import type { ModelFacts } from './measure-facts.js';

/**
 * Recommended actions (BR-511) and the human approval before any of them
 * changes anything (BR-512).
 *
 * Each recommendation comes from a forecast, cites the evidence it rests on —
 * the forecast itself, the work and cost entries behind it, each retrievable
 * by its link — and states its expected effect, worked out by forecasting
 * again as if it had been done. Each proposes exactly one change. Nothing is
 * changed when it is made, listed or read, by Pragnya or anyone: only a
 * person's approval applies it, through EPM's own API as that person — so
 * their permissions decide whether they may — and the approval and the change
 * are both journalled. Rejecting it is journalled too.
 */

export interface Evidence {
  kind: 'forecast' | 'work-package' | 'cost-entry' | 'history';
  id: string;
  label: string;
  value?: string | number | null;
  link: string;
  /** The label and value as templates, so each reader gets them in their language. */
  labelMessage?: Message;
  valueMessage?: Message;
}

export interface Change {
  entity: 'project-plan' | 'work-package';
  id: string;
  field: 'plannedFinish' | 'budgetTotal' | 'dueDate';
  from: string | number | null;
  to: string | number;
}

export interface RecommendationView {
  id: string;
  forecastId: string | null;
  projectId: string;
  kind: string;
  title: string;
  rationale: string;
  evidence: Evidence[];
  expectedEffect: { summary: string; before: number | string | null; after: number | string | null };
  change: Change;
  status: 'proposed' | 'applied' | 'rejected' | 'failed' | 'superseded';
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  appliedAt: string | null;
  applyError: string | null;
  createdAt: string;
}

interface Draft {
  projectId: number;
  forecastId: string;
  kind: string;
  targetKey: string;
  title: Message;
  rationale: Message;
  evidence: Evidence[];
  effect: Message;
  expectedEffect: Omit<RecommendationView['expectedEffect'], 'summary'>;
  change: Change;
}

/** A whole percentage, for a sentence. */
const pct = (value: number | null) => (value === null ? 0 : Math.round(value * 100));
const english = (value: Message) => render('en', value);
/** Evidence whose label and value are sentences: kept as templates, shown in English where it is stored. */
const evidence = (item: Omit<Evidence, 'label' | 'value' | 'labelMessage' | 'valueMessage'>, label: Message | string, value?: Message | number | null): Evidence => ({
  ...item,
  label: typeof label === 'string' ? label : english(label),
  ...(typeof label === 'string' ? {} : { labelMessage: label }),
  ...(value === undefined ? {} : typeof value === 'number' || value === null ? { value } : { value: english(value), valueMessage: value }),
});

/** Proposes from each forecast; supersedes older proposals for the same target. Returns how many are proposed now. */
export async function generateRecommendations(
  forecasts: { id: string; inputs: ProjectInput; output: ProjectForecast }[],
  context: { facts: ModelFacts; model: ForecastModel; calendar: Calendar },
): Promise<number> {
  const drafts: Draft[] = [];
  for (const { id, inputs, output } of forecasts) {
    const forecastEvidence = evidence({ kind: 'forecast', id, link: `/forecasts?project=${output.projectId}` }, message('Forecast for {project}', { project: output.name }));

    // 1. A finish the forecast says is unlikely: plan to the date it is 90 % likely by.
    if (output.probabilityOnTime !== null && output.probabilityOnTime < 0.5 && output.finish && output.plannedFinish !== null && output.finish.p90 > output.plannedFinish) {
      const to = output.finish.p90;
      const after = forecastProject({ ...inputs, plannedFinish: to }, context.model, context.calendar);
      drafts.push({
        projectId: output.projectId,
        forecastId: id,
        kind: 'replan-finish',
        targetKey: `project-plan:${output.projectId}:plannedFinish`,
        title: message('Move the planned finish of {project} to {date}', { project: output.name, date: dateOf(isoOf(to)) }),
        rationale: message('Its forecast gives {chance} % for finishing by {planned}; 9 times in 10 it finishes by {date}. The work that decides it is listed.', {
          chance: pct(output.probabilityOnTime),
          planned: dateOf(isoOf(output.plannedFinish)),
          date: dateOf(isoOf(to)),
        }),
        evidence: [
          forecastEvidence,
          ...output.factors.slice(0, 3).map((factor) =>
            evidence(
              { kind: 'work-package', id: String(factor.workPackageId), link: `/tasks/${factor.workPackageId}` },
              factor.subject,
              message('decides the finish in {share} % of runs; work like it finishes a median {days} working days late', { share: pct(factor.drivesFinish), days: factor.medianSlipDays }),
            ),
          ),
          evidence({ kind: 'history', id: context.model.version, link: '/forecasts' }, message('The organisation’s delivery history'), message('{count} finished work packages', { count: context.model.trainedOn.items })),
        ],
        effect: message('The plan becomes one the forecast expects to be met.'),
        expectedEffect: { before: output.probabilityOnTime, after: after.probabilityOnTime },
        change: { entity: 'project-plan', id: String(output.projectId), field: 'plannedFinish', from: isoOf(output.plannedFinish), to: isoOf(to) },
      });
    }

    // 2. Spend on course to pass the budget: a budget matching the likely cost, citing the cost behind it.
    if (output.cost.probabilityOverBudget !== null && output.cost.probabilityOverBudget >= 0.5 && output.cost.atCompletionP80 !== null && output.cost.budget !== null) {
      const to = output.cost.atCompletionP80;
      const after = forecastProject({ ...inputs, budget: to }, context.model, context.calendar);
      const entries = context.facts.time
        .filter((entry) => entry.projectId === output.projectId && (entry.cost ?? 0) > 0)
        .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
        .slice(0, 5);
      drafts.push({
        projectId: output.projectId,
        forecastId: id,
        kind: 'raise-budget',
        targetKey: `project-plan:${output.projectId}:budgetTotal`,
        title: message('Set the budget of {project} to {amount, number}', { project: output.name, amount: to }),
        rationale: message('At the rate its work has taken against estimates, it is {chance} % likely to pass its budget of {budget, number}; {amount, number} covers 8 runs in 10. Agree the budget, or reduce the scope.', {
          chance: pct(output.cost.probabilityOverBudget),
          budget: output.cost.budget,
          amount: to,
        }),
        evidence: [
          forecastEvidence,
          ...entries.map((entry) =>
            evidence(
              { kind: 'cost-entry', id: String(entry.id), link: entry.workPackageId ? `/tasks/${entry.workPackageId}` : `/projects/${output.projectId}` },
              message('Time on {date}', { date: dateOf(entry.spentOn) }),
              entry.cost,
            ),
          ),
        ],
        effect: message('The budget reflects the cost the forecast expects.'),
        expectedEffect: { before: output.cost.probabilityOverBudget, after: after.cost.probabilityOverBudget },
        change: { entity: 'project-plan', id: String(output.projectId), field: 'budgetTotal', from: output.cost.budget, to },
      });
    }

    // 3. The work that most often decides the finish, dated earlier than work like it ever finishes: a realistic due date.
    const lead = output.factors[0];
    const item = lead ? inputs.open.find((open) => open.id === lead.workPackageId) : undefined;
    if (lead && item && item.due !== null && lead.drivesFinish >= 0.5) {
      const slips = (context.model.groups[item.group]?.slips.length ?? 0) >= context.model.minGroupSize ? context.model.groups[item.group]!.slips : context.model.overall.slips;
      const p80 = percentile(slips, 80);
      const to = Math.max(inputs.today, addWorkingDays(context.calendar, item.due, p80));
      if (p80 > 0 && to > item.due) {
        drafts.push({
          projectId: output.projectId,
          forecastId: id,
          kind: 'replan-task',
          targetKey: `work-package:${item.id}:dueDate`,
          title: message('Give “{task}” a due date of {date}', { task: item.subject, date: dateOf(isoOf(to)) }),
          rationale: message('It decides the finish of {project} in {share} % of runs, and work like it finishes within {days} working days of its due date 8 times in 10.', {
            project: output.name,
            share: pct(lead.drivesFinish),
            days: p80,
          }),
          evidence: [
            evidence({ kind: 'work-package', id: String(item.id), link: `/tasks/${item.id}` }, item.subject, message('due {date}', { date: dateOf(isoOf(item.due)) })),
            forecastEvidence,
            evidence(
              { kind: 'history', id: context.model.version, link: '/forecasts' },
              message('Finished work like it'),
              message('{count} finished; 80 % within {days} working days of their due date', { count: slips.length, days: p80 }),
            ),
          ],
          effect: message('Its date, and what follows it, are planned as work like it actually finishes.'),
          expectedEffect: { before: isoOf(item.due), after: isoOf(to) },
          change: { entity: 'work-package', id: String(item.id), field: 'dueDate', from: isoOf(item.due), to: isoOf(to) },
        });
      }
    }
  }

  let proposed = 0;
  for (const draft of drafts) {
    const open = await prisma.recommendation.findFirst({ where: { targetKey: draft.targetKey, status: 'proposed' } });
    if (open && JSON.stringify(open.change) === JSON.stringify(draft.change)) {
      proposed += 1;
      continue;
    }
    if (open) await prisma.recommendation.update({ where: { id: open.id }, data: { status: 'superseded' } });
    await prisma.recommendation.create({
      data: {
        forecastId: draft.forecastId,
        projectId: draft.projectId,
        kind: draft.kind,
        targetKey: draft.targetKey,
        title: english(draft.title),
        rationale: english(draft.rationale),
        evidence: draft.evidence as unknown as Prisma.InputJsonValue,
        expectedEffect: { ...draft.expectedEffect, summary: english(draft.effect) } as unknown as Prisma.InputJsonValue,
        messages: { title: draft.title, rationale: draft.rationale, effect: draft.effect } as unknown as Prisma.InputJsonValue,
        change: draft.change as unknown as Prisma.InputJsonValue,
      },
    });
    proposed += 1;
  }
  return proposed;
}

type Row = Awaited<ReturnType<typeof prisma.recommendation.findFirstOrThrow>>;
/** In the reader's language: English as stored, any other from the stored templates. */
const toView = (row: Row): RecommendationView => {
  const messages = (row.messages ?? {}) as { title?: Message; rationale?: Message; effect?: Message };
  const effect = row.expectedEffect as unknown as RecommendationView['expectedEffect'];
  return {
  id: row.id,
  forecastId: row.forecastId,
  projectId: String(row.projectId),
  kind: row.kind,
  title: renderStored(row.title, messages.title),
  rationale: renderStored(row.rationale, messages.rationale),
  evidence: (row.evidence as unknown as Evidence[]).map(({ labelMessage, valueMessage, ...item }) => ({
    ...item,
    label: renderStored(item.label, labelMessage),
    ...(typeof item.value === 'string' ? { value: renderStored(item.value, valueMessage) } : {}),
  })),
  expectedEffect: { ...effect, summary: renderStored(effect.summary, messages.effect) },
  change: row.change as unknown as Change,
  status: row.status as RecommendationView['status'],
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  decisionComment: row.decisionComment,
  appliedAt: row.appliedAt?.toISOString() ?? null,
  applyError: row.applyError,
  createdAt: row.createdAt.toISOString(),
  };
};

export async function listRecommendations(projectIds: number[], status?: string): Promise<RecommendationView[]> {
  if (projectIds.length === 0) return [];
  const rows = await prisma.recommendation.findMany({
    where: { projectId: { in: projectIds }, ...(status ? { status } : { status: { not: 'superseded' } }) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return rows.map(toView);
}

export async function recommendationProject(id: string): Promise<number | null> {
  return (await prisma.recommendation.findUnique({ where: { id }, select: { projectId: true } }))?.projectId ?? null;
}

/** Calls EPM's own API as the person deciding: their access decides whether the change is theirs to make. */
async function asPerson(app: FastifyInstance, cookie: string, method: 'GET' | 'PATCH', path: string, body?: unknown) {
  const response = await app.inject({
    method,
    url: `${env.API_PREFIX}${path}`,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  let json: Record<string, unknown> = {};
  try {
    json = response.json();
  } catch {
    // Not JSON.
  }
  return { status: response.statusCode, json };
}

/** The value the change would replace, as it stands now. */
async function currentValue(app: FastifyInstance, cookie: string, change: Change): Promise<string | number | null> {
  if (change.entity === 'project-plan') {
    const project = await asPerson(app, cookie, 'GET', `/projects/${change.id}`);
    if (project.status >= 400) throw EpmError.notFound('That project');
    // The project view carries its planned finish as `dueDate`.
    const value = change.field === 'plannedFinish' ? project.json.dueDate : project.json.budgetTotal;
    return (value as string | number | null | undefined) ?? null;
  }
  const task = await asPerson(app, cookie, 'GET', `/tasks/${change.id}`);
  if (task.status >= 400) throw EpmError.notFound('That task');
  return (task.json.dueDate as string | null | undefined) ?? null;
}

/**
 * A person's decision (BR-512). Approving applies the one change, as them,
 * after checking nothing has moved since it was proposed; both the approval
 * and the change are journalled. Rejecting changes nothing and is journalled.
 */
export async function decideRecommendation(
  id: string,
  input: { decision: 'approve' | 'reject'; comment?: string | null },
  person: { userId: string; cookie: string; app: FastifyInstance },
): Promise<RecommendationView> {
  const row = await prisma.recommendation.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That recommendation');
  if (row.status !== 'proposed') throw EpmError.conflict('That recommendation has already been decided.');
  const change = row.change as unknown as Change;
  const comment = input.comment?.trim() || null;

  if (input.decision === 'reject') {
    const updated = await withAudit(
      (tx) => tx.recommendation.update({ where: { id }, data: { status: 'rejected', decidedBy: person.userId, decidedAt: new Date(), decisionComment: comment } }),
      () => ({
        actorId: person.userId,
        entityType: 'recommendation',
        entityId: id,
        action: 'recommendation.rejected',
        summary: message('Recommendation rejected: {title}', { title: row.title }),
        after: { change, comment },
      }),
    );
    return toView(updated);
  }

  const now = await currentValue(person.app, person.cookie, change);
  if (String(now ?? '') !== String(change.from ?? '')) {
    await prisma.recommendation.update({ where: { id }, data: { status: 'superseded' } });
    throw EpmError.conflict('That has changed since the recommendation was made, so it no longer applies.');
  }

  // The approval first, journalled before anything changes.
  await withAudit(
    (tx) => tx.recommendation.update({ where: { id }, data: { decidedBy: person.userId, decidedAt: new Date(), decisionComment: comment } }),
    () => ({
      actorId: person.userId,
      entityType: 'recommendation',
      entityId: id,
      action: 'recommendation.approved',
      summary: message('Recommendation approved: {title}', { title: row.title }),
      after: { change, comment },
    }),
  );

  const applied =
    change.entity === 'project-plan'
      ? await asPerson(person.app, person.cookie, 'PATCH', `/projects/${change.id}/plan`, { [change.field]: change.to })
      : await asPerson(person.app, person.cookie, 'PATCH', `/work-packages/${change.id}`, { payload: { [change.field]: change.to } });

  if (applied.status >= 400) {
    const reason = String(applied.json.message ?? `The change was refused (${applied.status}).`);
    const failed = await withAudit(
      (tx) => tx.recommendation.update({ where: { id }, data: { status: 'failed', applyError: reason.slice(0, 1000) } }),
      () => ({
        actorId: person.userId,
        entityType: 'recommendation',
        entityId: id,
        action: 'recommendation.failed',
        summary: message('Recommendation could not be applied: {reason}', { reason }),
        after: { change },
      }),
    );
    if (applied.status === 403) throw EpmError.forbidden(reason);
    return toView(failed);
  }

  const done = await withAudit(
    (tx) => tx.recommendation.update({ where: { id }, data: { status: 'applied', appliedAt: new Date() } }),
    () => ({
      actorId: person.userId,
      entityType: change.entity === 'project-plan' ? 'project' : 'work-package',
      entityId: change.id,
      action: 'recommendation.applied',
      summary: message('Recommendation applied: {field} {from} → {to}', { field: change.field, from: String(change.from ?? '—'), to: String(change.to) }),
      before: { [change.field]: change.from },
      after: { [change.field]: change.to, recommendationId: id, approvedBy: person.userId },
    }),
  );
  return toView(done);
}
