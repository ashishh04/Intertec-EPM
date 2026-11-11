import type { RiskAssessment as RiskAssessmentRow } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import type {
  EpmTask,
  RiskAssessment,
  RiskAssessmentInput,
  RiskCategory,
  RiskEntry,
  RiskRating,
  RiskResponse,
  RiskStage,
  TaskPriority,
} from '../types/epm.js';
import { withAudit } from './audit.js';

/**
 * The risk register.
 *
 * A risk is a work package of a risk type: the health rules' choice, or any
 * type named Risk (`resolveRiskSelection`). Its title, owner, status, dates and
 * severity are the work package's, so the dashboards, health and the journal
 * read risks as they always have. What no field there holds is kept here, one
 * row per work package: how likely it is, how bad it would be, the response
 * chosen and the plan for it.
 *
 * The rating (probability times impact) drives the work package's priority,
 * which is what health and the risk measures count as severity: rating and
 * severity never disagree.
 */

export const RISK_CATEGORIES: readonly RiskCategory[] = [
  'schedule',
  'cost',
  'scope',
  'quality',
  'resources',
  'technical',
  'external',
  'compliance',
  'security',
  'other',
];

export const RISK_RESPONSES: readonly RiskResponse[] = ['avoid', 'mitigate', 'transfer', 'accept', 'escalate'];

const TEXT_MAX = 4000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Probability times impact, 1 to 25, banded. */
export function ratingOf(score: number | null): RiskRating | null {
  if (score === null) return null;
  if (score >= 15) return 'critical';
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

/** The severity a rating sets: the work package priority category it maps to. */
export const PRIORITY_OF_RATING: Record<RiskRating, TaskPriority> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  critical: 'critical',
};

const scoreOf = (assessment: Pick<RiskAssessment, 'probability' | 'impact'>): number | null =>
  assessment.probability !== null && assessment.impact !== null ? assessment.probability * assessment.impact : null;

const EMPTY: RiskAssessment = {
  probability: null,
  impact: null,
  category: null,
  response: null,
  mitigation: null,
  contingency: null,
  reviewOn: null,
  updatedAt: null,
  updatedById: null,
};

function toAssessment(row: RiskAssessmentRow | undefined): RiskAssessment {
  if (!row) return EMPTY;
  return {
    probability: row.probability,
    impact: row.impact,
    category: (RISK_CATEGORIES as readonly string[]).includes(row.category ?? '') ? (row.category as RiskCategory) : null,
    response: (RISK_RESPONSES as readonly string[]).includes(row.response ?? '') ? (row.response as RiskResponse) : null,
    mitigation: row.mitigation,
    contingency: row.contingency,
    reviewOn: row.reviewOn ? row.reviewOn.toISOString().slice(0, 10) : null,
    updatedAt: row.updatedAt.toISOString(),
    updatedById: row.updatedBy,
  };
}

/** Where a risk stands, from its work package and its assessment. */
export function stageOf(task: Pick<EpmTask, 'status'>, assessment: RiskAssessment, today: string): RiskStage {
  if (task.status.isClosed) return 'closed';
  if (assessment.reviewOn !== null && assessment.reviewOn < today) return 'review';
  if (assessment.response !== null) return 'responding';
  if (scoreOf(assessment) !== null) return 'analysed';
  return 'identified';
}

export function toRiskEntry(task: EpmTask, row: RiskAssessmentRow | undefined, today: string): RiskEntry {
  const assessment = toAssessment(row);
  const score = scoreOf(assessment);
  return { task, assessment, score, rating: ratingOf(score), stage: stageOf(task, assessment, today) };
}

/** The assessments of these work packages, by id. */
export async function assessmentsOf(workPackageIds: number[]): Promise<Map<number, RiskAssessmentRow>> {
  if (workPackageIds.length === 0) return new Map();
  const rows = await prisma.riskAssessment.findMany({ where: { workPackageId: { in: workPackageIds } } });
  return new Map(rows.map((row) => [row.workPackageId, row]));
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function scale(value: unknown, field: 'probability' | 'impact'): number | null {
  if (value === null || value === '') return null;
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 5) {
    throw EpmError.badRequest(
      field === 'probability' ? 'The probability must be a whole number from 1 to 5.' : 'The impact must be a whole number from 1 to 5.',
    );
  }
  return number;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], problem: string): T | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw EpmError.badRequest(problem);
  return value as T;
}

function text(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw EpmError.badRequest(message('{field} must be text.', { field }));
  const trimmed = value.trim();
  if (trimmed.length > TEXT_MAX) {
    throw EpmError.badRequest(message('{field} cannot be longer than {max} characters.', { field, max: TEXT_MAX }));
  }
  return trimmed || null;
}

function day(value: unknown): Date | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw EpmError.badRequest('The review date must be a date.');
  }
  return new Date(`${value}T00:00:00.000Z`);
}

/** What was sent, checked; a field not sent is left as it is. */
export function validateAssessment(input: RiskAssessmentInput | undefined): {
  probability?: number | null;
  impact?: number | null;
  category?: string | null;
  response?: string | null;
  mitigation?: string | null;
  contingency?: string | null;
  reviewOn?: Date | null;
} {
  const body = (input ?? {}) as Record<string, unknown>;
  const data: ReturnType<typeof validateAssessment> = {};
  if (body.probability !== undefined) data.probability = scale(body.probability, 'probability');
  if (body.impact !== undefined) data.impact = scale(body.impact, 'impact');
  if (body.category !== undefined) data.category = oneOf(body.category, RISK_CATEGORIES, 'That category is not one the register offers.');
  if (body.response !== undefined) data.response = oneOf(body.response, RISK_RESPONSES, 'That response is not one the register offers.');
  if (body.mitigation !== undefined) data.mitigation = text(body.mitigation, 'The mitigation plan');
  if (body.contingency !== undefined) data.contingency = text(body.contingency, 'The contingency plan');
  if (body.reviewOn !== undefined) data.reviewOn = day(body.reviewOn);
  if (Object.keys(data).length === 0) throw EpmError.badRequest('There is nothing to update.');
  return data;
}

/** The score a save would leave, for the priority it sets. */
export function scoreAfter(
  existing: RiskAssessmentRow | undefined,
  data: ReturnType<typeof validateAssessment>,
): number | null {
  const probability = data.probability !== undefined ? data.probability : (existing?.probability ?? null);
  const impact = data.impact !== undefined ? data.impact : (existing?.impact ?? null);
  return probability !== null && impact !== null ? probability * impact : null;
}

/** What the journal keeps of an assessment. */
function record(row: RiskAssessmentRow | undefined) {
  if (!row) return null;
  return {
    probability: row.probability,
    impact: row.impact,
    category: row.category,
    response: row.response,
    mitigation: row.mitigation,
    contingency: row.contingency,
    reviewOn: row.reviewOn ? row.reviewOn.toISOString().slice(0, 10) : null,
  };
}

/** Saves the assessment of one risk, journalled with it. */
export async function saveAssessment(options: {
  workPackageId: number;
  projectId: number;
  subject: string;
  actorId: string;
  data: ReturnType<typeof validateAssessment>;
  existing: RiskAssessmentRow | undefined;
}): Promise<RiskAssessmentRow> {
  const { workPackageId, projectId, subject, actorId, data, existing } = options;
  return withAudit(
    (tx) =>
      tx.riskAssessment.upsert({
        where: { workPackageId },
        create: { workPackageId, projectId, updatedBy: actorId, ...data },
        update: { projectId, updatedBy: actorId, ...data },
      }),
    (saved) => ({
      entityType: 'risk',
      entityId: String(workPackageId),
      projectId: String(projectId),
      action: existing ? 'risk.reassessed' : 'risk.assessed',
      summary: existing
        ? message('Changed the assessment of risk {name}', { name: subject })
        : message('Assessed risk {name}', { name: subject }),
      before: record(existing),
      after: record(saved),
    }),
  );
}
