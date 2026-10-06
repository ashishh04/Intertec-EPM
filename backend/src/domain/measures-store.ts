import { prisma } from '../db/prisma.js';
import { addDays, today as todayIso } from '../lib/dates.js';
import { modelFacts } from './measure-facts.js';
import { catalogue, contextFor, evaluateInContext, MEASURES, prepare, type Scope } from './measures.js';

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
