import { env } from '../config/env.js';
import type { ToolContext, ToolDefinition } from './tools.js';

/**
 * Pragnya's analyses (BR-501, BR-502): risk exposure and budget exposure,
 * worked out from EPM's own figures read as the person asking — so each
 * returns only what they may see — and naming the evidence behind every
 * finding, with a link to each item, so a finding can be checked and acted on.
 */

interface Task {
  id: string;
  subject: string;
  projectId: string;
  priority?: string;
  status?: string;
  statusCategory?: string;
  dueDate?: string | null;
  typeRef?: { id?: string; name?: string };
}

interface Project {
  id: string;
  name: string;
  progress?: number;
  budgetTotal?: number | null;
  budgetUsed?: number | null;
  openRiskCount?: number;
  health?: { overall?: string };
}

interface CostEntry {
  id: string;
  kind: string;
  spentOn: string;
  hours?: number;
  userName?: string;
  workPackageId?: string;
  workPackageSubject?: string;
  cost: number;
}

/** Severities a risk's priority can carry that count as high. */
const HIGH = new Set(['high', 'immediate', 'urgent', 'critical']);
const FINDINGS_CAP = 15;
const EVIDENCE_CAP = 8;

/** GET through the API as the asker, as every tool does. */
async function get<T>(context: ToolContext, path: string): Promise<T> {
  const response = await context.app.inject({ method: 'GET', url: `${env.API_PREFIX}${path}`, headers: { cookie: context.request.headers.cookie ?? '' } });
  if (response.statusCode >= 400) {
    let message = `That request failed (${response.statusCode}).`;
    try {
      const body = response.json<{ message?: string }>();
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // Not JSON; the generic sentence stands.
    }
    // Loaded here, not at the top: tools.ts lists these tools, so a static
    // import of it would be a cycle.
    const { ToolError } = await import('./tools.js');
    throw new ToolError(message);
  }
  return response.json<T>();
}

const listOf = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : (((value as { items?: T[] })?.items ?? []) as T[]));
const today = () => new Date().toISOString().slice(0, 10);
const cite = (task: Task) => ({ id: task.id, subject: task.subject, due: task.dueDate ?? null, priority: task.priority ?? null, link: `/tasks/${task.id}` });

export const riskExposure: ToolDefinition = {
  name: 'risk_exposure',
  description:
    'Risk exposure across the projects the asker can see: where open risks concentrate (by project and severity), ' +
    'risks whose mitigation is past its due date, and projects where high risks sit beside slipping (overdue) work. ' +
    'Every finding lists the risks and tasks behind it. Use for "where is our risk", "which risks are overdue".',
  parameters: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
  label: () => 'Analysed risk exposure',
  async execute(context, args) {
    const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : undefined;
    const types = await get<{ id: string; name: string }[]>(context, '/catalog/types');
    const riskType = types.find((type) => type.name.toLowerCase() === 'risk');
    if (!riskType) return { findings: [], note: 'This instance has no Risk type, so there is no risk register to read.' };

    const scope = projectId ? `&projectId=${encodeURIComponent(projectId)}` : '';
    const [risks, overdue, projects] = await Promise.all([
      get<unknown>(context, `/tasks?typeId=${riskType.id}&bucket=open&pageSize=200${scope}`).then(listOf<Task>),
      get<unknown>(context, `/tasks?bucket=overdue&pageSize=200${scope}`).then(listOf<Task>),
      get<Project[]>(context, '/projects'),
    ]);
    const nameOf = new Map(projects.map((project) => [project.id, project.name]));
    const now = today();
    const high = (task: Task) => HIGH.has(String(task.priority ?? '').toLowerCase());
    const slipping = overdue.filter((task) => task.typeRef?.id !== riskType.id);

    // Concentration: projects by their open risks, high ones first.
    const byProject = new Map<string, Task[]>();
    for (const risk of risks) byProject.set(risk.projectId, [...(byProject.get(risk.projectId) ?? []), risk]);
    const concentration = [...byProject.entries()]
      .map(([id, list]) => ({ projectId: id, project: nameOf.get(id) ?? `#${id}`, openRisks: list.length, highRisks: list.filter(high).length, risks: list.slice(0, EVIDENCE_CAP).map(cite) }))
      .sort((a, b) => b.highRisks - a.highRisks || b.openRisks - a.openRisks)
      .slice(0, FINDINGS_CAP);

    // Mitigations overdue: open risks past their due date.
    const overdueMitigations = risks
      .filter((risk) => risk.dueDate && risk.dueDate < now)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
      .slice(0, FINDINGS_CAP)
      .map((risk) => ({ ...cite(risk), project: nameOf.get(risk.projectId) ?? `#${risk.projectId}`, daysOverdue: Math.round((Date.parse(now) - Date.parse(risk.dueDate!)) / 86_400_000) }));

    // Correlation: high risks in projects whose work is slipping.
    const correlated = [...byProject.entries()]
      .map(([id, list]) => ({ id, highRisks: list.filter(high), late: slipping.filter((task) => task.projectId === id) }))
      .filter((row) => row.highRisks.length > 0 && row.late.length > 0)
      .map((row) => ({ projectId: row.id, project: nameOf.get(row.id) ?? `#${row.id}`, highRisks: row.highRisks.slice(0, EVIDENCE_CAP).map(cite), slippingWork: row.late.slice(0, EVIDENCE_CAP).map(cite), slippingCount: row.late.length }))
      .slice(0, FINDINGS_CAP);

    return {
      asOf: now,
      openRisks: risks.length,
      highRisks: risks.filter(high).length,
      concentration,
      overdueMitigations,
      highRisksBesideSlippingWork: correlated,
      evidenceNote: 'Every item above is one the asker can open; links lead to each.',
    };
  },
};

export const budgetExposure: ToolDefinition = {
  name: 'budget_exposure',
  description:
    'Budget exposure across the projects the asker can see: spend so far against progress, the spend at completion ' +
    'that rate points to, and which projects are on a trajectory to overrun their budget, each with the cost entries ' +
    'that contribute most. Use for "which projects will go over budget", "where is spend running ahead of progress".',
  parameters: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
  label: () => 'Analysed budget exposure',
  allowed: (access) => access.allowFinance,
  async execute(context, args) {
    const only = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : undefined;
    const projects = (await get<Project[]>(context, '/projects')).filter((project) => (!only || project.id === only) && (project.budgetTotal ?? 0) > 0);
    const to = today();
    const from = new Date(Date.now() - 2 * 365 * 86_400_000 + 86_400_000).toISOString().slice(0, 10);

    const rows = await Promise.all(
      projects.map(async (project) => {
        const budget = Number(project.budgetTotal ?? 0);
        const spent = Number(project.budgetUsed ?? 0);
        const progress = Math.max(0, Math.min(100, Number(project.progress ?? 0)));
        // Spend at this rate to completion: what has been spent for the share done.
        const forecast = progress > 0 ? Math.round((spent / progress) * 100) : null;
        const overrunBy = forecast !== null ? forecast - budget : null;
        const trajectory =
          forecast !== null ? (forecast > budget ? 'overrun' : 'within budget') : spent > budget * 0.1 ? 'spending before progress' : 'too early to tell';
        return { project, budget, spent, progress, forecast, overrunBy, trajectory };
      }),
    );
    const flagged = rows
      .filter((row) => row.trajectory === 'overrun' || row.trajectory === 'spending before progress')
      .sort((a, b) => (b.overrunBy ?? b.spent) - (a.overrunBy ?? a.spent))
      .slice(0, FINDINGS_CAP);

    const findings = await Promise.all(
      flagged.map(async (row) => {
        const drill = await get<{ entries?: CostEntry[] }>(context, `/measures/cost.actual/entries?scope=project:${row.project.id}&from=${from}&to=${to}`).catch(() => ({ entries: [] }));
        const contributing = (drill.entries ?? [])
          .sort((a, b) => b.cost - a.cost)
          .slice(0, EVIDENCE_CAP)
          .map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            spentOn: entry.spentOn,
            cost: entry.cost,
            hours: entry.hours ?? null,
            by: entry.userName ?? null,
            task: entry.workPackageSubject ?? null,
            link: entry.workPackageId ? `/tasks/${entry.workPackageId}` : `/projects/${row.project.id}`,
          }));
        return {
          projectId: row.project.id,
          project: row.project.name,
          trajectory: row.trajectory,
          budget: row.budget,
          spent: row.spent,
          progressPercent: row.progress,
          forecastAtCompletion: row.forecast,
          overrunBy: row.overrunBy,
          contributingCostEntries: contributing,
          link: `/projects/${row.project.id}`,
        };
      }),
    );

    return {
      asOf: to,
      method: 'Spend at completion = spend so far ÷ progress. A project with spend but no progress yet is flagged when it has used more than a tenth of its budget.',
      projectsWithBudget: rows.length,
      withinBudget: rows.filter((row) => row.trajectory === 'within budget').length,
      findings,
      link: '/finance',
    };
  },
};

export const deliveryForecast: ToolDefinition = {
  name: 'delivery_forecast',
  description:
    'Delivery forecasts for the projects the asker can see, from a model trained on the organisation’s own finished work: ' +
    'the probability of finishing by the planned date, the finish range (P10, P50, P90), effort and cost at completion against budget, ' +
    'and the work that most often decides the finish. Use for "will we finish on time", "how likely", "when will it really finish".',
  parameters: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
  label: () => 'Looked up the delivery forecasts',
  async execute(context, args) {
    const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : undefined;
    const data = await get<{ run: unknown; forecasts: Record<string, unknown>[] }>(context, `/forecasts${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
    return {
      forecasts: data.forecasts.slice(0, FINDINGS_CAP).map((row) => ({
        id: row.id,
        project: row.name,
        projectId: row.projectId,
        probabilityOnTime: row.probabilityOnTime,
        plannedFinish: row.plannedFinish,
        finish: row.finish,
        effort: row.effort,
        cost: row.cost,
        factors: row.factors,
        trainedOn: row.trainedOn,
        link: `/forecasts?project=${String(row.projectId)}`,
      })),
      note: 'Forecasts are made from history; each can be reproduced from its stored inputs.',
    };
  },
};

export const recommendedActions: ToolDefinition = {
  name: 'recommended_actions',
  description:
    'Recommended actions waiting for a decision, for the projects the asker can see: each with its evidence, expected effect and the one ' +
    'change approving it would make. You cannot approve or apply them: a person does so under Insights → Forecasts.',
  parameters: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
  label: () => 'Looked up recommended actions',
  async execute(context, args) {
    const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : undefined;
    const rows = await get<Record<string, unknown>[]>(context, `/recommendations?status=proposed${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`);
    return {
      recommendations: rows.slice(0, FINDINGS_CAP).map((row) => ({ id: row.id, title: row.title, rationale: row.rationale, evidence: row.evidence, expectedEffect: row.expectedEffect, change: row.change })),
      howToApply: 'A person with the right to make the change approves it under Insights → Forecasts; nothing changes until then.',
      link: '/forecasts',
    };
  },
};
