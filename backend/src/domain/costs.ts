import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { durationToHours } from '../lib/duration.js';
import { roundMoney } from '../lib/money.js';
import { appLog } from '../lib/log.js';
import { linkId, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';

/**
 * Actual cost to date, per project.
 *
 * One definition, used by everything that shows or judges spend: the budget
 * figure on a project, portfolio totals and the budget criterion of health.
 * Before this, "budget used" was a number somebody typed in and nothing else
 * agreed with it.
 *
 * Today actual cost is labour: every hour logged on the project at the hourly
 * rate of the person who logged it. Non-labour cost joins it when the cost
 * ledger arrives with expense claims; it will be added here, not beside here.
 *
 * Read with the service key, never the viewer's: this is the project's cost,
 * not the part of it a particular person may see, and health computed from it
 * has to be the same for everybody.
 *
 * Rates are the current ones. Pricing past hours at the rate in force when
 * they were worked needs rate history (BRL-08), which EPM does not keep yet.
 */

export interface ProjectCost {
  /** Costed hours × rate, rounded to two places — and, once read, the other costs below. */
  cost: number;
  /**
   * Costs other than labour (Module 10): OpenProject unit costs, approved
   * expense claims among them, as the analytics model holds them.
   */
  otherCost?: number;
  costedHours: number;
  /** Hours from people with no hourly rate: counted, not priced at zero. */
  uncostedHours: number;
}

interface OpTimeEntryLite {
  hours?: string | null;
  _links?: Record<string, HalLink | undefined>;
}

const NONE: ProjectCost = { cost: 0, costedHours: 0, uncostedHours: 0 };

export { roundMoney };

/**
 * The cost of `hours` worked by someone at `rate` an hour.
 *
 * The one rule for labour cost. The analytics model prices each time entry
 * with it, and this module prices each project with it, so the two can only
 * disagree about which entries they saw, never about what an hour costs.
 */
export function labourCost(hours: number, rate: number): number {
  return roundMoney(hours * rate);
}

/**
 * What is known, and how far it can be trusted.
 *
 * After a walk over every time entry the cache is `complete`: a project with
 * no entry has no time logged, which is an answer rather than a gap. A project
 * marked `dirty` since then — somebody logged time there — is the exception,
 * and is read again however complete the rest is.
 */
const cache = new Map<string, ProjectCost>();
const dirty = new Set<string>();
let completeAt = 0;
const COMPLETE_FOR_MS = 15 * 60_000;

function complete(): boolean {
  return completeAt > 0 && Date.now() - completeAt < COMPLETE_FOR_MS;
}

/** Forgets one project's cost — after time is logged, changed or removed there. */
export function invalidateProjectCost(projectId: string): void {
  cache.delete(projectId);
  dirty.add(projectId);
}

/** Forgets every project's cost — after an hourly rate changes. */
export function invalidateAllProjectCosts(): void {
  cache.clear();
  dirty.clear();
  completeAt = 0;
}

async function loadRates(): Promise<Map<string, number>> {
  const rows = await prisma.userProfile
    .findMany({ where: { hourlyRate: { not: null } }, select: { openProjectId: true, hourlyRate: true } })
    .catch(() => [] as { openProjectId: string; hourlyRate: number | null }[]);
  return new Map(rows.map((row) => [row.openProjectId, row.hourlyRate ?? 0]));
}

function accumulate(entries: OpTimeEntryLite[], rates: Map<string, number>): Map<string, ProjectCost> {
  const totals = new Map<string, ProjectCost>();

  for (const entry of entries) {
    const projectId = linkId(entry._links, 'project');
    if (!projectId) continue;

    const hours = durationToHours(entry.hours) ?? 0;
    if (hours <= 0) continue;

    const total = totals.get(projectId) ?? { ...NONE };
    const userId = linkId(entry._links, 'user');
    const rate = userId ? rates.get(userId) : undefined;

    if (rate === undefined) {
      total.uncostedHours += hours;
    } else {
      total.cost += labourCost(hours, rate);
      total.costedHours += hours;
    }
    totals.set(projectId, total);
  }

  for (const total of totals.values()) {
    total.cost = roundMoney(total.cost);
    total.costedHours = roundMoney(total.costedHours);
    total.uncostedHours = roundMoney(total.uncostedHours);
  }
  return totals;
}

function known(projectId: string): ProjectCost | undefined {
  const hit = cache.get(projectId);
  if (hit) return hit;
  return complete() && !dirty.has(projectId) ? NONE : undefined;
}

/**
 * Actual cost for each of `projectIds`.
 *
 * A single unknown project is read on its own. Several are read in one walk
 * over every time entry instead: on any real instance that is far fewer
 * requests than one walk per project, and it leaves the cache complete.
 * `refresh` forces that walk — the scheduled sweep uses it, so time logged
 * directly in the instance is picked up even when nothing told EPM.
 *
 * A project whose cost could not be read is left out of the result rather
 * than reported as free, so a caller can say "not assessed".
 */
/**
 * Each project's costs other than labour, from the analytics model's copy of
 * OpenProject's cost entries: an approved expense claim counts once the model
 * has read it, minutes after it is posted (BR-309).
 */
async function otherCosts(projectIds: string[]): Promise<Map<string, number>> {
  const ids = projectIds.map(Number).filter((id) => Number.isInteger(id));
  if (ids.length === 0) return new Map();
  const rows = await prisma
    .$queryRawUnsafe<{ project_id: number; amount: number | null }[]>(
      'SELECT project_id, sum(amount)::float8 AS amount FROM analytics.fact_cost_entry WHERE project_id = ANY($1::int[]) GROUP BY project_id',
      ids,
    )
    .catch(() => []);
  return new Map(rows.map((row) => [String(row.project_id), roundMoney(Number(row.amount ?? 0))]));
}

export async function projectCosts(
  projectIds: string[],
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<Map<string, ProjectCost>> {
  return runAsSystem(async () => {
    const unknown = options.refresh ? projectIds : projectIds.filter((id) => !known(id));

    if (unknown.length > 0) {
      try {
        const rates = await loadRates();

        if (unknown.length === 1 && !options.refresh) {
          const [only] = unknown as [string];
          const entries = await openProject.getAll<OpTimeEntryLite>(
            '/time_entries',
            { filters: [{ field: 'project', operator: '=', values: [only] }] },
            { signal: options.signal },
          );
          cache.set(only, accumulate(entries.items, rates).get(only) ?? { ...NONE });
          dirty.delete(only);
        } else {
          const entries = await openProject.getAll<OpTimeEntryLite>(
            '/time_entries',
            { filters: [] },
            { signal: options.signal },
          );
          const totals = accumulate(entries.items, rates);
          cache.clear();
          dirty.clear();
          for (const [id, total] of totals) cache.set(id, total);
          completeAt = Date.now();
        }
      } catch (error) {
        appLog.warn({ err: error, projects: unknown.length }, 'Could not read time entries for project cost');
      }
    }

    const others = await otherCosts(projectIds);
    const result = new Map<string, ProjectCost>();
    for (const id of projectIds) {
      const cost = known(id);
      if (!cost) continue;
      const other = others.get(id) ?? 0;
      result.set(id, { ...cost, cost: roundMoney(cost.cost + other), otherCost: other });
    }
    return result;
  });
}
