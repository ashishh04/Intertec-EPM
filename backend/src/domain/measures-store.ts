import { prisma } from '../db/prisma.js';
import { addDays, today as todayIso } from '../lib/dates.js';
import { evaluateProjects } from './earned-value-store.js';
import { modelFacts, workFactsAsAt, type WorkFact } from './measure-facts.js';
import { bucketsOf, catalogue, contextFor, evaluateInContext, MEASURES, prepare, type Scope } from './measures.js';

/**
 * The semantic layer, published to the analytics schema (BR-404).
 *
 * A BI tool reading the replica must not define "overdue" for itself, or the
 * point of a semantic layer is lost on the first dashboard built outside EPM.
 * So the catalogue — every measure's name, unit and definition — is written to
 * `analytics.measure_definition`, and each measure's value for each day, for
 * the instance and every portfolio, project, department and team, to
 * `analytics.fact_measure_daily`, computed by the same functions EPM's own
 * dashboards call. A BI tool charts those; it does not recompute them.
 *
 * A day's value of a state measure (open, overdue, health) is the state that
 * day; of a period measure (delivered, utilisation), the 28 days ending that day.
 */

export const ROLLING_DAYS = 28;

const dateKey = (day: string) => Number(day.replaceAll('-', ''));

/** Writes the catalogue, so what BI reads is what the code defines. */
export async function publishCatalogue(): Promise<number> {
  const rows = catalogue().map((measure) => ({
    measure_id: measure.id,
    label: measure.label,
    unit: measure.unit,
    definition: measure.definition,
    grain: measure.usesPeriod ? `rolling ${ROLLING_DAYS} days ending on the day` : 'state on the day',
    version: measure.version,
  }));
  return prisma.$executeRawUnsafe(
    `INSERT INTO analytics.measure_definition (measure_id, label, unit, definition, grain, version, updated_at)
     SELECT r.measure_id, r.label, r.unit, r.definition, r.grain, r.version, now()
       FROM jsonb_to_recordset($1::jsonb) AS r(measure_id text, label text, unit text, definition text, grain text, version int)
     ON CONFLICT (measure_id) DO UPDATE SET label = EXCLUDED.label, unit = EXCLUDED.unit,
       definition = EXCLUDED.definition, grain = EXCLUDED.grain, version = EXCLUDED.version,
       updated_at = EXCLUDED.updated_at
     WHERE (analytics.measure_definition.label, analytics.measure_definition.unit, analytics.measure_definition.definition,
            analytics.measure_definition.grain, analytics.measure_definition.version)
           IS DISTINCT FROM (EXCLUDED.label, EXCLUDED.unit, EXCLUDED.definition, EXCLUDED.grain, EXCLUDED.version)`,
    JSON.stringify(rows),
  );
}

/** Whether today's values are already stored. */
export async function materialisedToday(day = todayIso()): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    'SELECT count(*) AS n FROM analytics.fact_measure_daily WHERE date_key = $1',
    dateKey(day),
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Computes and stores today's value of every measure, for the instance and
 * every portfolio, project, department and team, as the whole instance sees
 * it. Rerunning the same day overwrites that day.
 */
export async function materialiseMeasures(day = todayIso()): Promise<number> {
  await publishCatalogue();
  const facts = await modelFacts();
  const shared = await prepare({ visibleProjectIds: new Set(facts.projects.keys()) });
  const period = { from: addDays(day, -(ROLLING_DAYS - 1)), to: day };

  const scopes: Scope[] = [
    { kind: 'instance' },
    ...[...facts.portfolios.values()].filter((item) => item.active).map((item) => ({ kind: 'portfolio' as const, id: item.id })),
    ...[...facts.projects.values()].filter((item) => item.active).map((item) => ({ kind: 'project' as const, id: String(item.id) })),
    ...[...facts.departments.values()].filter((item) => item.active).map((item) => ({ kind: 'department' as const, id: item.id })),
    ...[...facts.teams.values()].filter((item) => item.active).map((item) => ({ kind: 'team' as const, id: item.id })),
  ];

  const rows: { measure_id: string; scope_type: string; scope_id: string; value: number | null }[] = [];
  for (const scope of scopes) {
    const context = contextFor(shared, scope, period, day);
    const ids = MEASURES.filter((measure) => measure.scopes.includes(scope.kind)).map((measure) => measure.id);
    const values = await evaluateInContext(ids, context);
    for (const [id, value] of Object.entries(values)) {
      rows.push({ measure_id: id, scope_type: scope.kind, scope_id: scope.id ?? '', value: value.value });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('DELETE FROM analytics.fact_measure_daily WHERE date_key = $1', dateKey(day));
    for (let at = 0; at < rows.length; at += 2000) {
      await tx.$executeRawUnsafe(
        `INSERT INTO analytics.fact_measure_daily (measure_id, scope_type, scope_id, date_key, value, computed_at)
         SELECT r.measure_id, r.scope_type, r.scope_id, $2, r.value, now()
           FROM jsonb_to_recordset($1::jsonb) AS r(measure_id text, scope_type text, scope_id text, value double precision)`,
        JSON.stringify(rows.slice(at, at + 2000)),
        dateKey(day),
      );
    }
  });
  return rows.length;
}

/**
 * Earned value over time, for BI (BR-303): the instance's, each active
 * portfolio's and each project's figures at the end of every week and every
 * month, from the earliest planned start to the latest planned finish — at
 * most two years either side of the day. Past periods are rebuilt from the
 * journals exactly as the Earned value dashboard rebuilds them; periods still
 * to come carry the plan alone. Rewritten whole, in one transaction.
 */
export async function materialiseEarnedValue(day = todayIso()): Promise<number> {
  const facts = await modelFacts();
  const shared = await prepare({ visibleProjectIds: new Set(facts.projects.keys()) });

  const dates: string[] = [];
  for (const work of facts.workPackages) {
    if (work.startDate) dates.push(work.startDate);
    if (work.dueDate) dates.push(work.dueDate);
  }
  for (const baselines of shared.evm.baselines.values()) {
    for (const baseline of baselines) {
      for (const item of baseline.items) {
        if (item.plannedStart) dates.push(item.plannedStart);
        if (item.plannedFinish) dates.push(item.plannedFinish);
      }
    }
  }
  if (dates.length === 0) {
    await prisma.$executeRawUnsafe('DELETE FROM analytics.fact_evm_period');
    return 0;
  }
  dates.sort();
  const earliest = addDays(day, -730);
  const latest = addDays(day, 730);
  const from = dates[0]! < earliest ? earliest : dates[0]!;
  const to = dates.at(-1)! > latest ? latest : dates.at(-1)! < day ? day : dates.at(-1)!;

  const scopes: Scope[] = [
    { kind: 'instance' },
    ...[...facts.portfolios.values()].filter((item) => item.active).map((item) => ({ kind: 'portfolio' as const, id: item.id })),
    ...[...facts.projects.values()].filter((item) => item.active).map((item) => ({ kind: 'project' as const, id: String(item.id) })),
  ];

  // The work as it stood at each past period's end, read once for every scope.
  const asAt = new Map<string, WorkFact[]>();
  const workAt = async (end: string): Promise<WorkFact[]> => {
    if (end >= day) return facts.workPackages;
    let found = asAt.get(end);
    if (!found) {
      found = await workFactsAsAt(new Date(`${addDays(end, 1)}T00:00:00.000Z`), facts);
      asAt.set(end, found);
    }
    return found;
  };

  type Row = Record<string, string | number | boolean | null>;
  const rows: Row[] = [];
  for (const bucket of ['week', 'month'] as const) {
    for (const slice of bucketsOf({ from, to }, bucket)) {
      const ahead = slice.from > day;
      const at = slice.to < day ? slice.to : ahead ? slice.to : day;
      const work = await workAt(slice.to < day ? slice.to : day);
      for (const scope of scopes) {
        const context = contextFor(shared, scope, { from: at, to: at }, at);
        const result = evaluateProjects(shared.evm, {
          projectIds: context.projects.map((project) => project.id),
          at,
          work: work.filter(context.inScope),
          time: context.time,
        });
        const { totals } = result;
        if (totals.bac === 0 && totals.ac === 0) continue;
        const against = result.projects.filter((project) => project.evaluation.totals.bac > 0 || project.evaluation.totals.ac > 0);
        const baselined = against.filter((project) => project.measuredAgainst.kind === 'baseline');
        rows.push({
          scope_type: scope.kind,
          scope_id: scope.id ?? '',
          bucket,
          period_start: slice.from,
          period_end: slice.to,
          period_end_key: dateKey(slice.to),
          measured_against:
            against.length === 1
              ? against[0]!.measuredAgainst.kind === 'baseline'
                ? `baseline ${(against[0]!.measuredAgainst as { number: number }).number}`
                : 'current plan'
              : `${baselined.length} of ${against.length} projects against a baseline`,
          bac: totals.bac,
          pv: totals.pv,
          ev: ahead ? null : totals.ev,
          ac: ahead ? null : totals.ac,
          sv: ahead ? null : totals.sv,
          cv: ahead ? null : totals.cv,
          spi: ahead ? null : totals.spi,
          cpi: ahead ? null : totals.cpi,
          eac: ahead ? null : totals.eac,
          etc: ahead ? null : totals.etc,
          vac: ahead ? null : totals.vac,
          tcpi: ahead ? null : totals.tcpi,
          is_forecast: ahead,
        });
      }
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('DELETE FROM analytics.fact_evm_period');
    for (let at = 0; at < rows.length; at += 2000) {
      await tx.$executeRawUnsafe(
        `INSERT INTO analytics.fact_evm_period (scope_type, scope_id, bucket, period_start, period_end, period_end_key,
                measured_against, bac, pv, ev, ac, sv, cv, spi, cpi, eac, etc, vac, tcpi, is_forecast, computed_at)
         SELECT r.scope_type, r.scope_id, r.bucket, r.period_start, r.period_end, r.period_end_key, r.measured_against,
                r.bac, r.pv, r.ev, r.ac, r.sv, r.cv, r.spi, r.cpi, r.eac, r.etc, r.vac, r.tcpi, r.is_forecast, now()
           FROM jsonb_to_recordset($1::jsonb) AS r(scope_type text, scope_id text, bucket text, period_start date,
                period_end date, period_end_key int, measured_against text, bac float8, pv float8, ev float8, ac float8,
                sv float8, cv float8, spi float8, cpi float8, eac float8, etc float8, vac float8, tcpi float8,
                is_forecast boolean)`,
        JSON.stringify(rows.slice(at, at + 2000)),
      );
    }
  }, { timeout: 60_000 });
  return rows.length;
}
