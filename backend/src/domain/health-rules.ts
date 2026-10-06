import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { getCatalog } from '../mapping/catalog.js';
import type { HealthCriterion, HealthRuleOptions, HealthRules } from '../types/epm.js';
import { withAudit } from './audit.js';

/**
 * The rules project health is computed by (BR-204).
 *
 * Administrator-configured, and versioned: a save never edits the rules in
 * force, it adds the next version, so every stored calculation names exactly
 * the rules it used and the journal shows what changed between two of them.
 * Until somebody saves, the defaults below apply as version 0.
 *
 * The defaults are chosen so that, with nothing configured, any one criterion
 * crossing its amber or red line moves the overall — the behaviour the
 * product had before the rules were configurable, kept as the starting point.
 */

export const HEALTH_CRITERIA: HealthCriterion[] = ['schedule', 'budget', 'risks', 'overdue'];

export const DEFAULT_HEALTH_RULES: HealthRules = {
  version: 0,
  criteria: {
    // Calendar days past the planned finish. A week of slip is worth a look;
    // three is a plan that no longer holds.
    schedule: { enabled: true, weight: 25, amberAt: 5, redAt: 15 },
    // Percent of the whole budget by which spend is ahead of the plan to date.
    budget: { enabled: true, weight: 25, amberAt: 5, redAt: 10 },
    // Open high-priority risks.
    risks: { enabled: true, weight: 25, amberAt: 1, redAt: 3, typeIds: [], priorityIds: [] },
    // Open work past its due date.
    overdue: { enabled: true, weight: 25, amberAt: 3, redAt: 10 },
  },
  redShare: 25,
  amberShare: 25,
};

const idList = z
  .array(z.string().regex(/^\d+$/, 'Ids are numeric.'))
  .max(50, 'Choose at most 50.')
  .transform((ids) => [...new Set(ids)]);

function criterionSchema(name: string, unit: 'days' | 'percent' | 'count') {
  // Counts are whole numbers; a threshold of half a risk means nothing.
  const threshold = unit === 'count'
    ? z.number().int(`${name} thresholds are whole numbers.`)
    : z.number();

  return z
    .object({
      enabled: z.boolean(),
      weight: z.number().int('Weights are whole numbers.').min(0).max(100),
      // Zero would make every project amber the moment it existed.
      amberAt: threshold.positive(`${name}: the amber threshold must be above zero.`).max(100_000),
      redAt: threshold.positive(`${name}: the red threshold must be above zero.`).max(100_000),
    })
    .refine((rule) => rule.redAt >= rule.amberAt, {
      message: `${name}: the red threshold cannot be below the amber one.`,
    });
}

const rulesSchema = z
  .object({
    criteria: z.object({
      schedule: criterionSchema('Schedule variance', 'days'),
      budget: criterionSchema('Budget variance', 'percent'),
      risks: criterionSchema('Open high risks', 'count').and(
        z.object({ typeIds: idList.default([]), priorityIds: idList.default([]) }),
      ),
      overdue: criterionSchema('Overdue items', 'count'),
    }),
    redShare: z.number().int().min(1).max(100),
    amberShare: z.number().int().min(1).max(100),
  })
  .refine(
    (rules) => HEALTH_CRITERIA.some((key) => rules.criteria[key].enabled && rules.criteria[key].weight > 0),
    { message: 'At least one criterion has to be in use with a weight above zero.' },
  );

export type HealthRulesInput = z.input<typeof rulesSchema>;

/**
 * Validates an administrator's rules.
 *
 * Every message names the criterion it is about, because the editor shows
 * them all at once and "must be above zero" alone does not say where.
 */
export function parseHealthRules(input: unknown): Omit<HealthRules, 'version'> {
  const result = rulesSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw EpmError.validation(issue?.message ?? 'Those rules are not valid.', result.error.issues);
  }
  return result.data;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

let cached: { rules: HealthRules; at: number } | undefined;
const CACHE_MS = 30_000;

/**
 * The rules in force.
 *
 * A stored version that no longer validates — written by an older build, or
 * edited by hand — is skipped for the newest one that does, and the defaults
 * are the last resort. Health must always be computable; refusing to compute
 * it because of one bad row would blank every project page.
 */
export async function getHealthRules(): Promise<HealthRules> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rules;

  const rows = await prisma.healthRuleSet
    .findMany({ orderBy: { version: 'desc' }, take: 5 })
    .catch(() => []);

  let rules: HealthRules = DEFAULT_HEALTH_RULES;
  for (const row of rows) {
    const parsed = rulesSchema.safeParse(row.rules);
    if (!parsed.success) continue;
    rules = {
      ...parsed.data,
      version: row.version,
      updatedAt: row.createdAt.toISOString(),
      updatedBy: row.createdBy,
    };
    break;
  }

  cached = { rules, at: Date.now() };
  return rules;
}

/** Forgets the cached rules, so the next read sees a save at once. */
export function forgetHealthRules(): void {
  cached = undefined;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/** "amber at 5, red at 15 days" — for the journal's summary of a change. */
function describeChanges(before: HealthRules, after: Omit<HealthRules, 'version'>): string[] {
  const labels: Record<HealthCriterion, string> = {
    schedule: 'schedule variance',
    budget: 'budget variance',
    risks: 'open high risks',
    overdue: 'overdue items',
  };

  const changes: string[] = [];
  for (const key of HEALTH_CRITERIA) {
    const was = before.criteria[key];
    const now = after.criteria[key];
    if (was.enabled !== now.enabled) changes.push(`${labels[key]} ${now.enabled ? 'turned on' : 'turned off'}`);
    if (was.weight !== now.weight) changes.push(`${labels[key]} weight ${was.weight} → ${now.weight}`);
    if (was.amberAt !== now.amberAt || was.redAt !== now.redAt) {
      changes.push(`${labels[key]} amber/red ${was.amberAt}/${was.redAt} → ${now.amberAt}/${now.redAt}`);
    }
  }

  const wasRisks = before.criteria.risks;
  const nowRisks = after.criteria.risks;
  if (wasRisks.typeIds.join() !== nowRisks.typeIds.join()) changes.push('risk types changed');
  if (wasRisks.priorityIds.join() !== nowRisks.priorityIds.join()) changes.push('high priorities changed');
  if (before.redShare !== after.redShare) changes.push(`red share ${before.redShare}% → ${after.redShare}%`);
  if (before.amberShare !== after.amberShare) {
    changes.push(`amber share ${before.amberShare}% → ${after.amberShare}%`);
  }
  return changes;
}

/**
 * Saves new rules as the next version, and journals it.
 *
 * A save that changes nothing is refused with a 409 rather than adding a
 * version identical to the last: every version should be a decision somebody
 * made, and a history padded with no-op saves hides the real ones.
 */
export async function saveHealthRules(input: unknown, actorId: string): Promise<HealthRules> {
  const next = parseHealthRules(input);
  const current = await getHealthRules();

  const changes = describeChanges(current, next);
  if (changes.length === 0) throw EpmError.conflict('Those are already the rules in force.');

  const saved = await withAudit(
    async (tx) => {
      const top = await tx.healthRuleSet.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
      const version = (top?.version ?? 0) + 1;
      return tx.healthRuleSet.create({
        data: { version, rules: next as unknown as object, createdBy: actorId },
      });
    },
    (row) => ({
      actorId,
      entityType: 'health-rules',
      entityId: String(row.version),
      action: 'health.rules.updated',
      summary: `Health rules version ${row.version}: ${changes.join('; ')}.`,
      before: { version: current.version, ...stripMeta(current) },
      after: { version: row.version, ...next },
    }),
  );

  forgetHealthRules();
  return { ...next, version: saved.version, updatedAt: saved.createdAt.toISOString(), updatedBy: actorId };
}

function stripMeta(rules: HealthRules): Omit<HealthRules, 'version' | 'updatedAt' | 'updatedBy'> {
  const { version: _v, updatedAt: _a, updatedBy: _b, ...rest } = rules;
  return rest;
}

/* -------------------------------------------------------------------------- */
/* What "risk" and "high" mean on this instance                               */
/* -------------------------------------------------------------------------- */

const RISK_TYPE_NAME = /\brisks?\b/i;

/**
 * The types and priorities the risks criterion counts.
 *
 * An explicit selection in the rules wins. Without one, a type is a risk if
 * its name says so, and "high" is every priority the catalogue reads as high
 * or above — so a fresh instance with a "Risk" type works with nothing
 * configured, and one without says the criterion is not assessed rather than
 * reporting zero risks it has no way to count.
 */
export async function resolveRiskSelection(
  rules: HealthRules,
  signal?: AbortSignal,
): Promise<{ typeIds: string[]; priorityIds: string[]; options: HealthRuleOptions }> {
  const catalog = await runAsSystem(() => getCatalog(signal));

  const types = [...catalog.typeById.values()].map(({ id, name }) => ({ id, name }));
  const priorities = [...catalog.priorityById.values()].map(({ id, name }) => ({ id, name }));
  const defaultRiskTypeIds = types.filter((type) => RISK_TYPE_NAME.test(type.name)).map((type) => type.id);
  const defaultHighPriorityIds = [...catalog.priorityById.values()]
    .filter((priority) => priority.epm === 'high' || priority.epm === 'critical')
    .map((priority) => priority.id);

  const known = (ids: string[], from: { id: string }[]) => ids.filter((id) => from.some((item) => item.id === id));
  const chosenTypes = known(rules.criteria.risks.typeIds, types);
  const chosenPriorities = known(rules.criteria.risks.priorityIds, priorities);

  return {
    typeIds: chosenTypes.length > 0 ? chosenTypes : defaultRiskTypeIds,
    priorityIds: chosenPriorities.length > 0 ? chosenPriorities : defaultHighPriorityIds,
    options: { types, priorities, defaultRiskTypeIds, defaultHighPriorityIds },
  };
}
