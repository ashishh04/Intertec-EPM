import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { appLog } from '../lib/log.js';
import {
  contextConventions,
  contextLanguage,
  isMessage,
  listOf,
  message,
  msg,
  render,
  renderStored,
  t,
  type Message,
} from '../lib/i18n.js';
import { openProject } from '../openproject/client.js';
import type {
  CalculatedField as CalculatedFieldView,
  CalculatedFieldReferences,
  CalculatedFieldValidation,
  CalculatedResultType,
  CalculatedRun as CalculatedRunView,
  CalculatedStatus,
  CalculatedValue as CalculatedValueView,
  FormulaReference,
} from '../types/epm.js';
import { withAudit, recordAuditQuietly } from './audit.js';
import {
  ATTRIBUTES,
  ATTRIBUTE_HELP,
  compileFormula,
  customFieldType,
  DEFAULT_DECIMALS,
  encodeValue,
  evaluateFields,
  findCycle,
  FORMAT_OF,
  FUNCTIONS,
  inScope,
  keyProblem,
  LIMITS,
  outputValue,
  readCustomValue,
  VALUE_TYPES,
  type Compiled,
  type FieldPlan,
  type FormulaEnvironment,
  type FormulaError,
  type Outcome,
  type References,
  type Value,
  type ValueType,
  type WorkItem,
} from './expression.js';
import { withLease } from './job-lease.js';
import { calendarOf } from './schedule.js';

/**
 * Calculated fields (BRQ-04: BR-406 to BR-408), end to end.
 *
 * A definition is EPM's: a name, a key formulas know it by, the type it gives,
 * the formula (`expression.ts`) and where it applies. Each one has an
 * OpenProject custom field of its own, made through the administration
 * catalogue when the definition is saved and marked as one EPM computes
 * (`zzz_epm_calculated.rb`), so OpenProject's query engine — which EPM's views
 * run on — shows it as a column and filters, groups and sums on it, and its
 * API and EPM's carry it, with nothing reimplemented. The approach Module 5
 * proved for float.
 *
 * Values are computed on write and kept (BR-408): a pass reads every input in
 * one request, evaluates every field on every work package — children before
 * parents, and on each one a field after those it reads — stores what changed
 * in `calculated_values`, and writes only the changed values into OpenProject.
 * A pass runs
 * - after EPM changes work: queued beside the critical path's, debounced, in
 *   the background — the request that made the change never waits;
 * - when a definition is saved, switched on or off, or someone asks;
 * - when the check finds OpenProject has moved under EPM — an edit made in its
 *   own screens, time logged, a value typed over — or the day has changed and
 *   a formula reads TODAY().
 *
 * Calculated fields are read-only to people: EPM's forms show them so, and
 * its write routes refuse a value for one (`refuseCalculatedWrites`).
 */

export type CalculatedTrigger = 'change' | 'check' | 'manual' | 'startup' | 'definition' | 'day';

/** How long one pass may hold the lease before another server may take over. */
const LEASE_MS = 10 * 60_000;
/** Changes arrive in bursts; they become one pass. */
const DEBOUNCE_MS = 1_500;
/** Work packages per write to OpenProject. */
const MIRROR_BATCH = 2_000;
/** How long the definitions and OpenProject's custom field list are kept. */
const CACHE_MS = 30_000;
/** How long a pass's record is kept. */
const RUN_RETENTION_DAYS = 30;

/* -------------------------------------------------------------------------- */
/* OpenProject                                                                */
/* -------------------------------------------------------------------------- */

/** A work package custom field, as the bridge describes it. */
interface OpCustomField {
  id: number;
  name: string;
  format: string;
  multiValue: boolean;
  /** One EPM computes (`editable = false`). */
  calculated: boolean;
  isForAll: boolean;
  isFilter: boolean;
  typeIds: number[];
  projectIds: number[];
  /** A list field's options, id → label. */
  options: Record<string, string> | null;
}

interface InputWorkPackage {
  id: number;
  projectId: number;
  typeId: number;
  parentId: number | null;
  estimatedHours: number | null;
  remainingHours: number | null;
  spentHours: number | null;
  percentDone: number | null;
  startDate: string | null;
  dueDate: string | null;
  storyPoints: number | null;
  /** Referenced custom fields' stored values, by field id. */
  custom: Record<string, (string | null)[]>;
  /** The computed fields' values now, by field id. */
  current: Record<string, string | null>;
  /** The computed fields this work package can hold. */
  holds: number[];
}

interface Inputs {
  workPackages: InputWorkPackage[];
  customFields: Record<string, OpCustomField>;
  calendar: { workingDays: number[]; nonWorkingDays: string[] };
  fingerprint: { inputs: string; values: string } | null;
}

interface Fingerprint {
  inputs: string;
  values: string;
  workPackages: number;
}

interface MirrorOutcome {
  written: number;
  cleared: number;
  unchanged: number;
  skipped: number;
  touched: number;
}

const asSystem = <T>(path: string, options: Parameters<typeof openProject.request>[1] = {}) =>
  runAsSystem(() => openProject.request<T>(path, { root: true, timeoutMs: 120_000, ...options }));

/** The bridge's answer that it is not installed: zzz_epm_calculated.rb is not loaded. */
const bridgeMissing = (error: unknown) => error instanceof OpenProjectError && error.upstreamStatus === 404;

function bridgeError(error: unknown): never {
  if (bridgeMissing(error)) {
    throw EpmError.unavailable('OpenProject cannot hold calculated fields yet: zzz_epm_calculated.rb is not loaded there.', error);
  }
  throw error;
}

let customFieldCache: { at: number; value: Promise<OpCustomField[]> } | undefined;

/** OpenProject's work package custom fields. Kept briefly. */
export function openProjectCustomFields(fresh = false): Promise<OpCustomField[]> {
  if (!fresh && customFieldCache && Date.now() - customFieldCache.at < CACHE_MS) return customFieldCache.value;
  const value = asSystem<{ fields: OpCustomField[] }>('/epm_admin/calculated/fields')
    .then((body) => body.fields)
    .catch(bridgeError)
    .catch((error: unknown) => {
      customFieldCache = undefined;
      throw error;
    });
  customFieldCache = { at: Date.now(), value };
  return value;
}

function readInputs(customIds: number[], root?: number): Promise<Inputs> {
  return asSystem<Inputs>('/epm_admin/calculated/inputs', {
    query: { fields: customIds.join(','), ...(root ? { root } : {}) },
  }).catch(bridgeError);
}

function readFingerprint(customIds: number[]): Promise<Fingerprint> {
  return asSystem<Fingerprint>('/epm_admin/calculated/fingerprint', { query: { fields: customIds.join(',') } }).catch(bridgeError);
}

function writeValues(values: { id: number; values: Record<string, string | null> }[]): Promise<MirrorOutcome> {
  return asSystem<MirrorOutcome>('/epm_admin/calculated/values', { method: 'POST', body: { values } });
}

/** Makes `customFieldId` one EPM computes, active on the scope's types and projects. */
function configureCustomField(customFieldId: number, scope: { projectIds: number[]; typeIds: number[] }): Promise<OpCustomField> {
  return asSystem<OpCustomField>(`/epm_admin/calculated/fields/${customFieldId}`, { method: 'POST', body: scope }).catch(bridgeError);
}

/** The administration catalogue, as the system: a refusal reads as OpenProject wrote it. */
async function catalogue<T>(path: string, options: { method: 'POST' | 'PATCH' | 'DELETE'; body?: unknown }): Promise<T> {
  try {
    return await asSystem<T>(`/epm_admin/catalog/custom-fields${path}`, options);
  } catch (error) {
    if (error instanceof OpenProjectError && error.upstreamStatus === 422) throw EpmError.validation(error.message);
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Definitions                                                                */
/* -------------------------------------------------------------------------- */

type FieldRow = Awaited<ReturnType<typeof prisma.calculatedField.findFirstOrThrow>>;

let definitionCache: { at: number; value: Promise<FieldRow[]> } | undefined;

/** Every definition, active or not. Kept briefly: other servers save too. */
function definitions(): Promise<FieldRow[]> {
  if (definitionCache && Date.now() - definitionCache.at < CACHE_MS) return definitionCache.value;
  const value = prisma.calculatedField.findMany({ orderBy: { name: 'asc' } }).catch((error: unknown) => {
    definitionCache = undefined;
    throw error;
  });
  definitionCache = { at: Date.now(), value };
  return value;
}

function forgetDefinitions(): void {
  definitionCache = undefined;
  customFieldCache = undefined;
}

const typeOfRow = (row: Pick<FieldRow, 'resultType'>): ValueType =>
  (VALUE_TYPES as readonly string[]).includes(row.resultType) ? (row.resultType as ValueType) : 'number';

const decimalsOf = (row: Pick<FieldRow, 'format'>): number => {
  const decimals = (row.format as { decimals?: unknown } | null)?.decimals;
  return typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 6 ? decimals : DEFAULT_DECIMALS;
};

const referencesOf = (row: Pick<FieldRow, 'references'>): References => {
  const stored = (row.references ?? {}) as Partial<References>;
  return {
    attributes: stored.attributes ?? [],
    customFields: stored.customFields ?? [],
    calculated: stored.calculated ?? [],
    childCalculated: stored.childCalculated ?? [],
    children: stored.children ?? false,
    today: stored.today ?? false,
    calendar: stored.calendar ?? false,
  };
};

function toView(row: FieldRow, stats?: { values: number; empty: number }): CalculatedFieldView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? undefined,
    resultType: typeOfRow(row),
    expression: row.expression,
    references: referencesOf(row) as CalculatedFieldReferences,
    format: { decimals: typeOfRow(row) === 'number' ? decimalsOf(row) : undefined },
    customFieldId: row.customFieldId === null ? undefined : String(row.customFieldId),
    column: row.customFieldId === null ? undefined : `customField${row.customFieldId}`,
    projectIds: (row.projectIds ?? []).map(String),
    typeIds: (row.typeIds ?? []).map(String),
    active: row.active,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    stats,
  };
}

/**
 * What formulas may read here: OpenProject's custom fields and EPM's
 * definitions (`readable`), with the field being written among them — a field
 * may roll itself up. A custom field that holds a calculated field's values is
 * named by that field's key instead, whichever definitions are readable.
 */
function environmentOf(
  customFields: readonly OpCustomField[],
  readable: readonly FieldRow[],
  all: readonly FieldRow[],
  ...selves: ({ key: string; name: string; type: ValueType } | undefined)[]
): FormulaEnvironment {
  const keyOfCustomField = new Map(all.filter((row) => row.customFieldId !== null).map((row) => [row.customFieldId!, row.key]));
  const calculated = new Map(readable.map((row) => [row.key, { name: row.name, type: typeOfRow(row), active: row.active }]));
  for (const self of selves) if (self) calculated.set(self.key, { name: self.name, type: self.type, active: true });
  return {
    customFields: new Map(
      customFields.map((field) => [
        field.id,
        { name: field.name, format: field.format, type: customFieldType(field.format), calculatedKey: keyOfCustomField.get(field.id) },
      ]),
    ),
    calculated,
  };
}

const numericIds = z.array(z.union([z.string().regex(/^\d+$/, msg('Ids are whole numbers.')), z.number().int().positive()])).max(500);

const definitionInput = z.object({
  key: z.string().trim(),
  name: z.string().trim().min(1, msg('A calculated field needs a name.')).max(80, msg('A name has at most 80 characters.')),
  description: z.string().trim().max(500, msg('A description has at most 500 characters.')).nullable().optional(),
  resultType: z.enum(['number', 'date', 'text', 'boolean']),
  expression: z.string().max(LIMITS.length, msg('The formula is too long.')),
  format: z
    .object({ decimals: z.number().int().min(0, msg('From 0 to 6 decimal places.')).max(6, msg('From 0 to 6 decimal places.')).optional() })
    .optional(),
  projectIds: numericIds.optional(),
  typeIds: numericIds.optional(),
});

const definitionPatch = definitionInput.partial();

export type DefinitionInput = z.infer<typeof definitionInput>;

/** A formula problem as the API gives it, in the reader's language. */
function problemView(error: FormulaError) {
  return { message: render(contextLanguage(), error.message, contextConventions()), start: error.start, end: error.end };
}

/** Refuses a formula that does not compile, pointing at where. */
function refuseFormula(error: FormulaError): never {
  throw EpmError.validation(error.message, { field: 'expression', start: error.start, end: error.end });
}

/**
 * Compiles a definition against everything there is, and refuses a circle:
 * the fields it reads on the same work package must not lead back to it.
 */
function compileDefinition(
  draft: { key: string; name: string; resultType: ValueType; expression: string },
  rows: readonly FieldRow[],
  customFields: readonly OpCustomField[],
  editingId?: string,
): { compiled: Compiled } | { error: FormulaError } {
  const others = rows.filter((row) => row.id !== editingId && row.key !== draft.key);
  const result = compileFormula(
    draft.expression,
    environmentOf(customFields, others, rows, { key: draft.key, name: draft.name, type: draft.resultType }),
    draft.resultType,
  );
  if (!result.ok) return { error: result.error };

  const edges = new Map<string, string[]>(others.filter((row) => row.active).map((row) => [row.key, referencesOf(row).calculated]));
  edges.set(draft.key, result.compiled.references.calculated);
  const cycle = findCycle(draft.key, (key) => edges.get(key) ?? []);
  if (cycle) {
    return { error: { message: message('Circular reference: {path}.', { path: cycle.join(' → ') }), start: 0, end: draft.expression.length } };
  }
  return { compiled: result.compiled };
}

/** The active fields that read `key`, on the same work package or its children. */
function readersOf(key: string, rows: readonly FieldRow[]): FieldRow[] {
  return rows.filter((row) => row.key !== key && row.active && [...referencesOf(row).calculated, ...referencesOf(row).childCalculated].includes(key));
}

const toNumbers = (ids: readonly (string | number)[] | undefined) => [...new Set((ids ?? []).map(Number))].sort((a, b) => a - b);

export async function listCalculatedFields(): Promise<CalculatedFieldView[]> {
  const [rows, stats] = await Promise.all([
    prisma.calculatedField.findMany({ orderBy: { name: 'asc' } }),
    prisma.$queryRaw<{ fieldId: string; values: bigint; empty: bigint }[]>`
      SELECT "fieldId", count(*) AS values,
             count(*) FILTER (WHERE "numberValue" IS NULL AND "dateValue" IS NULL AND "textValue" IS NULL AND "booleanValue" IS NULL) AS empty
        FROM calculated_values GROUP BY "fieldId"`,
  ]);
  const byField = new Map(stats.map((row) => [row.fieldId, { values: Number(row.values), empty: Number(row.empty) }]));
  return rows.map((row) => toView(row, byField.get(row.id) ?? { values: 0, empty: 0 }));
}

export async function getCalculatedField(id: string): Promise<CalculatedFieldView> {
  const row = await prisma.calculatedField.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound(msg('That calculated field'));
  const [stats] = await prisma.$queryRaw<{ values: bigint; empty: bigint }[]>`
    SELECT count(*) AS values,
           count(*) FILTER (WHERE "numberValue" IS NULL AND "dateValue" IS NULL AND "textValue" IS NULL AND "booleanValue" IS NULL) AS empty
      FROM calculated_values WHERE "fieldId" = ${id}`;
  return toView(row, { values: Number(stats?.values ?? 0), empty: Number(stats?.empty ?? 0) });
}

/** Refuses ids of projects or types OpenProject does not have. */
async function checkScope(projectIds: number[], typeIds: number[]): Promise<void> {
  const [projects, types] = await Promise.all([
    projectIds.length
      ? runAsSystem(() =>
          openProject.getCollection<{ id: number }>('/projects', {
            filters: [{ field: 'id', operator: '=', values: projectIds.map(String) }],
            pageSize: projectIds.length,
          }),
        )
      : undefined,
    typeIds.length ? runAsSystem(() => openProject.request<{ _embedded?: { elements?: { id: number }[] } }>('/types')) : undefined,
  ]);
  const knownProjects = new Set((projects?._embedded?.elements ?? []).map((project) => project.id));
  const missingProject = projectIds.find((id) => !knownProjects.has(id));
  if (projects && missingProject !== undefined) throw EpmError.validation(message('There is no project {id}.', { id: missingProject }));
  const knownTypes = new Set((types?._embedded?.elements ?? []).map((type) => type.id));
  const missingType = typeIds.find((id) => !knownTypes.has(id));
  if (types && missingType !== undefined) throw EpmError.validation(message('There is no type {id}.', { id: missingType }));
}

/**
 * Defines a calculated field: checks the formula, makes its OpenProject custom
 * field through the administration catalogue and marks it as one EPM computes
 * for the field's scope, saves the definition journalled, and starts a pass.
 */
export async function createCalculatedField(input: unknown, actorId: string): Promise<CalculatedFieldView> {
  const draft = definitionInput.parse(input ?? {});
  const problem = keyProblem(draft.key);
  if (problem) throw EpmError.validation(problem, { field: 'key' });
  const [rows, customFields] = await Promise.all([prisma.calculatedField.findMany(), openProjectCustomFields(true)]);
  if (rows.some((row) => row.key === draft.key)) {
    throw EpmError.conflict(message('There is already a calculated field with the key {key}.', { key: draft.key }));
  }
  if (rows.some((row) => row.name.toLowerCase() === draft.name.toLowerCase())) {
    throw EpmError.conflict(message('There is already a calculated field called {name}.', { name: draft.name }));
  }
  const compiled = compileDefinition({ ...draft, resultType: draft.resultType }, rows, customFields);
  if ('error' in compiled) refuseFormula(compiled.error);

  const projectIds = toNumbers(draft.projectIds);
  const typeIds = toNumbers(draft.typeIds);
  await checkScope(projectIds, typeIds);

  // OpenProject's own field first: if it refuses the name, nothing is saved.
  const made = await catalogue<{ id: string }>('', {
    method: 'POST',
    body: { name: draft.name, fieldFormat: FORMAT_OF[draft.resultType], isRequired: false, isForAll: projectIds.length === 0, isFilter: true },
  });
  const customFieldId = Number(made.id);
  const undo = () =>
    catalogue<void>(`/${customFieldId}`, { method: 'DELETE' }).catch((error: unknown) =>
      appLog.warn({ err: error, customFieldId }, 'A custom field made for a calculated field that was not saved could not be removed'),
    );

  let row: FieldRow;
  try {
    await configureCustomField(customFieldId, { projectIds, typeIds });
    row = await withAudit(
      (tx) =>
        tx.calculatedField.create({
          data: {
            key: draft.key,
            name: draft.name,
            description: draft.description || null,
            resultType: draft.resultType,
            expression: draft.expression,
            references: compiled.compiled.references as unknown as Prisma.InputJsonValue,
            format: draft.resultType === 'number' ? { decimals: draft.format?.decimals ?? DEFAULT_DECIMALS } : {},
            customFieldId,
            projectIds,
            typeIds,
            createdBy: actorId,
            updatedBy: actorId,
          },
        }),
      (created) => ({
        actorId,
        entityType: 'calculated-field',
        entityId: created.id,
        action: 'calculated-field.created',
        summary: message('Calculated field {name} ({key}) defined: {expression}', {
          name: created.name,
          key: created.key,
          expression: created.expression,
        }),
        after: { ...created, createdAt: undefined, updatedAt: undefined },
      }),
    );
  } catch (error) {
    await undo();
    throw error;
  }
  forgetDefinitions();
  requestCalculatedRecalc('definition');
  return toView(row, { values: 0, empty: 0 });
}

/**
 * Changes a definition. The key and the result type are fixed once the field
 * exists — formulas name it by the one, and its OpenProject field holds the
 * other — so a new key or type is a new field.
 */
export async function updateCalculatedField(id: string, input: unknown, actorId: string): Promise<CalculatedFieldView> {
  const patch = definitionPatch.parse(input ?? {});
  const [rows, customFields] = await Promise.all([prisma.calculatedField.findMany(), openProjectCustomFields(true)]);
  const current = rows.find((row) => row.id === id);
  if (!current) throw EpmError.notFound(msg('That calculated field'));
  if (patch.key !== undefined && patch.key !== current.key) {
    throw EpmError.conflict('A calculated field’s key cannot change: formulas refer to it. Define a new field instead.');
  }
  if (patch.resultType !== undefined && patch.resultType !== current.resultType) {
    throw EpmError.conflict('A calculated field’s type cannot change once it exists. Define a new field instead.');
  }
  if (patch.name !== undefined && patch.name.toLowerCase() !== current.name.toLowerCase() && rows.some((row) => row.id !== id && row.name.toLowerCase() === patch.name!.toLowerCase())) {
    throw EpmError.conflict(message('There is already a calculated field called {name}.', { name: patch.name }));
  }

  const next = {
    name: patch.name ?? current.name,
    description: patch.description === undefined ? current.description : patch.description || null,
    expression: patch.expression ?? current.expression,
    decimals: typeOfRow(current) === 'number' ? (patch.format?.decimals ?? decimalsOf(current)) : undefined,
    projectIds: patch.projectIds ? toNumbers(patch.projectIds) : (current.projectIds ?? []),
    typeIds: patch.typeIds ? toNumbers(patch.typeIds) : (current.typeIds ?? []),
  };
  const compiled = compileDefinition({ key: current.key, name: next.name, resultType: typeOfRow(current), expression: next.expression }, rows, customFields, id);
  if ('error' in compiled) refuseFormula(compiled.error);

  const changes: Message[] = [];
  if (next.name !== current.name) changes.push(message('name {from} → {to}', { from: current.name, to: next.name }));
  if (next.expression !== current.expression) changes.push(message('formula {from} → {to}', { from: current.expression, to: next.expression }));
  if (next.decimals !== undefined && next.decimals !== decimalsOf(current)) {
    changes.push(message('decimal places {from} → {to}', { from: decimalsOf(current), to: next.decimals }));
  }
  const scopeChanged =
    next.projectIds.join() !== (current.projectIds ?? []).join() || next.typeIds.join() !== (current.typeIds ?? []).join();
  if (scopeChanged) changes.push(message('where it applies'));
  if ((next.description ?? null) !== (current.description ?? null)) changes.push(message('description'));
  if (changes.length === 0) throw EpmError.conflict('Nothing has changed.');

  if (scopeChanged) await checkScope(next.projectIds, next.typeIds);
  if (current.customFieldId !== null) {
    if (next.name !== current.name) await catalogue(`/${current.customFieldId}`, { method: 'PATCH', body: { name: next.name } });
    if (scopeChanged) await configureCustomField(current.customFieldId, { projectIds: next.projectIds, typeIds: next.typeIds });
  }

  const recompute = next.expression !== current.expression || next.decimals !== decimalsOf(current) || scopeChanged;
  const saved = await withAudit(
    (tx) =>
      tx.calculatedField.update({
        where: { id },
        data: {
          name: next.name,
          description: next.description,
          expression: next.expression,
          references: compiled.compiled.references as unknown as Prisma.InputJsonValue,
          format: next.decimals !== undefined ? { decimals: next.decimals } : {},
          projectIds: next.projectIds,
          typeIds: next.typeIds,
          version: recompute ? { increment: 1 } : undefined,
          updatedBy: actorId,
        },
      }),
    (row) => ({
      actorId,
      entityType: 'calculated-field',
      entityId: row.id,
      action: 'calculated-field.updated',
      summary: message('Calculated field {name} ({key}) changed: {changes}.', { name: row.name, key: row.key, changes: listOf(changes) }),
      before: { ...current, createdAt: undefined, updatedAt: undefined },
      after: { ...row, createdAt: undefined, updatedAt: undefined },
    }),
  );
  forgetDefinitions();
  if (recompute) requestCalculatedRecalc('definition');
  return getCalculatedField(saved.id);
}

/**
 * Switches a field off: it is no longer computed, its values go from EPM and
 * are cleared from OpenProject, and its definition and OpenProject field stay,
 * so views that show it keep their column. Refused while another active field
 * reads it.
 */
export async function setCalculatedFieldActive(id: string, active: boolean, actorId: string): Promise<CalculatedFieldView> {
  const [rows, customFields] = await Promise.all([prisma.calculatedField.findMany(), active ? openProjectCustomFields(true) : Promise.resolve([])]);
  const current = rows.find((row) => row.id === id);
  if (!current) throw EpmError.notFound(msg('That calculated field'));
  if (current.active === active) {
    throw EpmError.conflict(active ? 'That calculated field is already on.' : 'That calculated field is already off.');
  }
  let references = referencesOf(current);
  if (active) {
    const compiled = compileDefinition({ key: current.key, name: current.name, resultType: typeOfRow(current), expression: current.expression }, rows, customFields, id);
    if ('error' in compiled) refuseFormula(compiled.error);
    references = compiled.compiled.references;
  } else {
    const readers = readersOf(current.key, rows);
    if (readers.length > 0) {
      throw EpmError.conflict(
        message('{name} is read by {fields}; change or switch those off first.', { name: current.name, fields: listOf(readers.map((row) => row.name), 'and') }),
      );
    }
  }
  const saved = await withAudit(
    async (tx) => {
      if (!active) await tx.calculatedValue.deleteMany({ where: { fieldId: id } });
      return tx.calculatedField.update({
        where: { id },
        data: { active, references: references as unknown as Prisma.InputJsonValue, version: { increment: 1 }, updatedBy: actorId },
      });
    },
    (row) => ({
      actorId,
      entityType: 'calculated-field',
      entityId: row.id,
      action: active ? 'calculated-field.activated' : 'calculated-field.deactivated',
      summary: active
        ? message('Calculated field {name} ({key}) switched on.', { name: row.name, key: row.key })
        : message('Calculated field {name} ({key}) switched off; its values are cleared.', { name: row.name, key: row.key }),
    }),
  );
  forgetDefinitions();
  requestCalculatedRecalc('definition');
  return getCalculatedField(saved.id);
}

/** Deletes a field, its values and its OpenProject custom field. Refused while any field reads it. */
export async function deleteCalculatedField(id: string, actorId: string): Promise<void> {
  const rows = await prisma.calculatedField.findMany();
  const current = rows.find((row) => row.id === id);
  if (!current) throw EpmError.notFound(msg('That calculated field'));
  const readers = rows.filter(
    (row) => row.id !== id && [...referencesOf(row).calculated, ...referencesOf(row).childCalculated].includes(current.key),
  );
  if (readers.length > 0) {
    throw EpmError.conflict(
      message('{name} is read by {fields}; change or delete those first.', { name: current.name, fields: listOf(readers.map((row) => row.name), 'and') }),
    );
  }
  if (current.customFieldId !== null) {
    await catalogue<void>(`/${current.customFieldId}`, { method: 'DELETE' }).catch((error: unknown) => {
      // Already gone upstream: nothing left to remove there.
      if (error instanceof EpmError && error.status === 404) return;
      throw error;
    });
  }
  await withAudit(
    (tx) => tx.calculatedField.delete({ where: { id } }),
    {
      actorId,
      entityType: 'calculated-field',
      entityId: id,
      action: 'calculated-field.deleted',
      summary: message('Calculated field {name} ({key}) deleted, with its values and its OpenProject field.', {
        name: current.name,
        key: current.key,
      }),
      before: { ...current, createdAt: undefined, updatedAt: undefined },
    },
  );
  forgetDefinitions();
}

/* -------------------------------------------------------------------------- */
/* Validation and preview                                                     */
/* -------------------------------------------------------------------------- */

const validationInput = z.object({
  id: z.string().optional(),
  key: z.string().trim().optional(),
  name: z.string().trim().optional(),
  resultType: z.enum(['number', 'date', 'text', 'boolean']),
  expression: z.string().max(LIMITS.length * 2),
  projectIds: numericIds.optional(),
  typeIds: numericIds.optional(),
  workPackageId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
});

/**
 * Checks a formula as it is typed — syntax, types, references, circles and the
 * bounds, with positions — and, given a work package, works it out there: on
 * that work package and everything under it, with every other field as it is.
 */
export async function validateFormula(input: unknown): Promise<CalculatedFieldValidation> {
  const draft = validationInput.parse(input ?? {});
  const [rows, customFields] = await Promise.all([prisma.calculatedField.findMany(), openProjectCustomFields()]);
  const key = draft.key && !keyProblem(draft.key) ? draft.key : '__draft__';
  const resultType = draft.resultType as ValueType;
  const limits = { ...LIMITS };
  const result = compileDefinition({ key, name: draft.name || key, resultType, expression: draft.expression }, rows, customFields, draft.id);
  if ('error' in result) return { ok: false, error: problemView(result.error), limits };
  const compiled = result.compiled;
  const view: CalculatedFieldValidation = {
    ok: true,
    type: compiled.type,
    references: compiled.references as CalculatedFieldReferences,
    complexity: compiled.complexity,
    limits,
  };
  if (draft.workPackageId === undefined) return view;

  const workPackageId = Number(draft.workPackageId);
  const active = rows.filter((row) => row.active && row.id !== draft.id && row.key !== key);
  const customIds = [...new Set([...compiled.references.customFields, ...active.flatMap((row) => referencesOf(row).customFields)])];
  const inputs = await readInputs(customIds, workPackageId);
  const plans = plansFor(active, inputs, rows, { key, name: draft.name || key, type: resultType });
  plans.push({
    id: '__draft__',
    key,
    type: resultType,
    compiled,
    projectIds: null,
    typeIds: null,
  });
  const items = itemsOf(inputs);
  const target = items.find((entry) => entry.id === workPackageId);
  if (!target) throw EpmError.notFound(message('Work package {id}', { id: workPackageId }));
  const results = evaluateFields(plans, items, { today: todayIso(), calendar: calendarOf(inputs) });
  const outcome = results.get('__draft__')!.get(workPackageId) ?? { value: null };
  const scope = { projectIds: setOrNull(toNumbers(draft.projectIds)), typeIds: setOrNull(toNumbers(draft.typeIds)) };
  view.preview = {
    workPackageId: String(workPackageId),
    value: outputValue(resultType, outcome.value),
    reason: outcome.reason ? render(contextLanguage(), outcome.reason, contextConventions()) : undefined,
    inScope: inScope(scope, target),
  };
  return view;
}

const setOrNull = (ids: number[]) => (ids.length > 0 ? new Set(ids) : null);

const todayIso = () => new Date().toISOString().slice(0, 10);

/** The formula reference beside the editor: fields, functions, custom fields, other calculated fields. */
export async function formulaReference(): Promise<FormulaReference> {
  const language = contextLanguage();
  const conventions = contextConventions();
  const [rows, customFields] = await Promise.all([definitions(), openProjectCustomFields().catch(() => [] as OpCustomField[])]);
  const calculatedIds = new Set(rows.map((row) => row.customFieldId));
  return {
    attributes: Object.entries(ATTRIBUTES).map(([name, type]) => ({
      name,
      type,
      description: t(language, ATTRIBUTE_HELP[name as keyof typeof ATTRIBUTES], undefined, conventions),
    })),
    functions: Object.entries(FUNCTIONS).map(([name, spec]) => ({
      name,
      signature: spec.signature,
      description: t(language, spec.help, undefined, conventions),
      aggregate: spec.aggregate === true,
    })),
    customFields: customFields
      .filter((field) => !calculatedIds.has(field.id) && !field.calculated)
      .map((field) => ({ name: `cf_${field.id}`, label: field.name, format: field.format, type: customFieldType(field.format) })),
    calculated: rows.map((row) => ({ key: row.key, name: row.name, type: typeOfRow(row), active: row.active })),
    limits: { ...LIMITS },
  };
}

/* -------------------------------------------------------------------------- */
/* One pass                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Compiles the fields a pass evaluates. Each may read the others given, and
 * `extra` — a draft being previewed; one that no longer compiles (a custom
 * field it read was deleted upstream) is evaluated as empty, with the reason.
 */
function plansFor(
  rows: readonly FieldRow[],
  inputs: Pick<Inputs, 'customFields'>,
  all: readonly FieldRow[],
  extra?: { key: string; name: string; type: ValueType },
): FieldPlan[] {
  const customFields = Object.values(inputs.customFields);
  return rows.map((row) => {
    const type = typeOfRow(row);
    const environment = environmentOf(customFields, rows, all, { key: row.key, name: row.name, type }, extra);
    const result = compileFormula(row.expression, environment, type);
    return {
      id: row.id,
      key: row.key,
      type,
      ...(result.ok ? { compiled: result.compiled } : { broken: result.error.message }),
      projectIds: setOrNull(row.projectIds ?? []),
      typeIds: setOrNull(row.typeIds ?? []),
    };
  });
}

function itemsOf(inputs: Inputs): WorkItem[] {
  const fields = new Map(Object.values(inputs.customFields).map((field) => [field.id, field]));
  return inputs.workPackages.map((wp) => {
    const custom = new Map<number, Value>();
    for (const [id, raws] of Object.entries(wp.custom)) {
      const field = fields.get(Number(id));
      const type = field ? customFieldType(field.format) : null;
      if (!field || !type) continue;
      custom.set(field.id, readCustomValue(type, raws, field.options ? new Map(Object.entries(field.options)) : undefined));
    }
    return {
      id: wp.id,
      projectId: wp.projectId,
      typeId: wp.typeId,
      parentId: wp.parentId,
      estimatedHours: wp.estimatedHours,
      remainingHours: wp.remainingHours,
      spentHours: wp.spentHours,
      percentDone: wp.percentDone,
      startDate: wp.startDate,
      dueDate: wp.dueDate,
      storyPoints: wp.storyPoints,
      custom,
    };
  });
}

/** EPM's digest of the definitions in force: a definition changed on any server moves it. */
function definitionsFingerprint(rows: readonly FieldRow[]): string {
  const text = rows
    .map((row) => `${row.id}:${row.version}:${row.active}:${row.customFieldId}`)
    .sort()
    .join('|');
  return createHash('sha1').update(text).digest('hex');
}

const customIdsOf = (rows: readonly FieldRow[]) =>
  [...new Set(rows.filter((row) => row.active).flatMap((row) => referencesOf(row).customFields))].sort((a, b) => a - b);

const usesToday = (rows: readonly FieldRow[]) => rows.some((row) => row.active && referencesOf(row).today);

type RunRow = Awaited<ReturnType<typeof prisma.calculatedRun.findFirstOrThrow>>;

function toRunView(row: RunRow): CalculatedRunView {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
    day: row.day ?? undefined,
    fields: row.fields,
    workPackages: row.workPackages,
    evaluated: row.evaluated,
    empty: row.empty,
    changed: row.changed,
    removed: row.removed,
    mirrored: row.mirrored,
    mirrorSkipped: row.mirrorSkipped,
    mirrorError: row.mirrorError ? renderStored(row.mirrorError) : undefined,
    readMs: row.readMs ?? undefined,
    computeMs: row.computeMs ?? undefined,
    storeMs: row.storeMs ?? undefined,
    mirrorMs: row.mirrorMs ?? undefined,
    durationMs: row.durationMs ?? undefined,
    error: row.error ?? undefined,
  };
}

/** A value as stored: one typed column per result type. */
interface StoredValue {
  fieldId: string;
  workPackageId: number;
  projectId: number;
  numberValue: number | null;
  dateValue: string | null;
  textValue: string | null;
  booleanValue: boolean | null;
  reason: string | null;
  reasonMessage: Message | null;
  fieldVersion: number;
}

function storedOf(row: FieldRow, workPackageId: number, projectId: number, outcome: Outcome): StoredValue {
  const type = typeOfRow(row);
  const value = outcome.value;
  return {
    fieldId: row.id,
    workPackageId,
    projectId,
    numberValue: type === 'number' && value !== null ? (value as number) : null,
    dateValue: type === 'date' && value !== null ? (outputValue('date', value) as string) : null,
    textValue: type === 'text' && value !== null ? (value as string) : null,
    booleanValue: type === 'boolean' && value !== null ? (value as boolean) : null,
    reason: value === null && outcome.reason ? render('en', outcome.reason) : null,
    reasonMessage: value === null && outcome.reason ? outcome.reason : null,
    fieldVersion: row.version,
  };
}

const sameStored = (a: StoredValue, b: StoredValue) =>
  a.projectId === b.projectId &&
  a.numberValue === b.numberValue &&
  a.dateValue === b.dateValue &&
  a.textValue === b.textValue &&
  a.booleanValue === b.booleanValue &&
  a.reason === b.reason &&
  a.fieldVersion === b.fieldVersion;

/** Writes the values that changed and removes those that no longer apply, in one transaction. */
async function storeValues(runId: string, wanted: StoredValue[]): Promise<{ changed: number; removed: number }> {
  const existing = await prisma.calculatedValue.findMany();
  const keyOf = (fieldId: string, workPackageId: number) => `${fieldId}:${workPackageId}`;
  const before = new Map(
    existing.map((row) => [
      keyOf(row.fieldId, row.workPackageId),
      {
        fieldId: row.fieldId,
        workPackageId: row.workPackageId,
        projectId: row.projectId,
        numberValue: row.numberValue,
        dateValue: row.dateValue ? row.dateValue.toISOString().slice(0, 10) : null,
        textValue: row.textValue,
        booleanValue: row.booleanValue,
        reason: row.reason,
        reasonMessage: null,
        fieldVersion: row.fieldVersion,
      } satisfies StoredValue,
    ]),
  );
  const kept = new Set(wanted.map((value) => keyOf(value.fieldId, value.workPackageId)));
  const changed = wanted.filter((value) => {
    const old = before.get(keyOf(value.fieldId, value.workPackageId));
    return !old || !sameStored(old, value);
  });
  const removed = existing.filter((row) => !kept.has(keyOf(row.fieldId, row.workPackageId)));
  if (changed.length + removed.length === 0) return { changed: 0, removed: 0 };

  await prisma.$transaction(
    async (tx) => {
      if (removed.length > 0) {
        await tx.$executeRaw`
          DELETE FROM calculated_values v
           USING UNNEST(${removed.map((row) => row.fieldId)}::text[], ${removed.map((row) => row.workPackageId)}::int[]) AS gone(field, wp)
           WHERE v."fieldId" = gone.field AND v."workPackageId" = gone.wp`;
      }
      for (let at = 0; at < changed.length; at += 5_000) {
        const slice = changed.slice(at, at + 5_000);
        const column = <T>(pick: (value: StoredValue) => T) => slice.map(pick);
        await tx.$executeRaw`
          INSERT INTO calculated_values ("fieldId", "workPackageId", "projectId", "numberValue", "dateValue", "textValue",
                                         "booleanValue", "reason", "reasonMessage", "fieldVersion", "runId", "updatedAt")
          SELECT u.field, u.wp, u.project, u.num, u.day::date, u.txt, u.bool, u.why, u.whymsg::jsonb, u.version, ${runId}, now()
            FROM UNNEST(${column((v) => v.fieldId)}::text[], ${column((v) => v.workPackageId)}::int[], ${column((v) => v.projectId)}::int[],
                        ${column((v) => v.numberValue)}::float8[], ${column((v) => v.dateValue)}::text[], ${column((v) => v.textValue)}::text[],
                        ${column((v) => v.booleanValue)}::boolean[], ${column((v) => v.reason)}::text[],
                        ${column((v) => (v.reasonMessage ? JSON.stringify(v.reasonMessage) : null))}::text[],
                        ${column((v) => v.fieldVersion)}::int[])
                 AS u(field, wp, project, num, day, txt, bool, why, whymsg, version)
          ON CONFLICT ("fieldId", "workPackageId") DO UPDATE SET
            "projectId" = EXCLUDED."projectId", "numberValue" = EXCLUDED."numberValue", "dateValue" = EXCLUDED."dateValue",
            "textValue" = EXCLUDED."textValue", "booleanValue" = EXCLUDED."booleanValue", "reason" = EXCLUDED."reason",
            "reasonMessage" = EXCLUDED."reasonMessage", "fieldVersion" = EXCLUDED."fieldVersion", "runId" = EXCLUDED."runId",
            "updatedAt" = EXCLUDED."updatedAt"`;
      }
    },
    { timeout: 60_000 },
  );
  return { changed: changed.length, removed: removed.length };
}

/**
 * Brings OpenProject's fields in line: each work package that can hold a
 * field gets its value, or none; a field switched off has its values cleared;
 * only what differs from what is stored is sent.
 */
async function mirrorValues(
  rows: readonly FieldRow[],
  inputs: Inputs,
  results: Map<string, Map<number, Outcome>>,
  customIds: number[],
): Promise<{ mirrored: number; skipped: number; valuesFingerprint: string | null; error?: string }> {
  const mirrored = rows.filter((row) => row.customFieldId !== null && inputs.customFields[String(row.customFieldId)]?.calculated);
  let skipped = 0;
  const pending: { id: number; values: Record<string, string | null> }[] = [];
  for (const wp of inputs.workPackages) {
    const values: Record<string, string | null> = {};
    for (const row of mirrored) {
      const field = String(row.customFieldId);
      const outcome = row.active ? results.get(row.id)?.get(wp.id) : undefined;
      let want = outcome ? encodeValue(typeOfRow(row), outcome.value, decimalsOf(row)) : null;
      if (want !== null && !wp.holds.includes(row.customFieldId!)) {
        skipped += 1;
        want = null;
      }
      if ((wp.current[field] ?? null) !== want) values[field] = want;
    }
    if (Object.keys(values).length > 0) pending.push({ id: wp.id, values });
  }
  if (pending.length === 0) return { mirrored: 0, skipped, valuesFingerprint: inputs.fingerprint?.values ?? null };

  let touched = 0;
  try {
    for (let at = 0; at < pending.length; at += MIRROR_BATCH) {
      touched += (await writeValues(pending.slice(at, at + MIRROR_BATCH))).touched;
    }
    // The digest after writing, so the check does not take EPM's own writes for somebody else's.
    const after = await readFingerprint(customIds);
    return { mirrored: touched, skipped, valuesFingerprint: after.values };
  } catch (error) {
    appLog.warn({ err: error }, 'Calculated field mirror failed; the next check retries it');
    // No digest: the next check sees a difference and tries again.
    return {
      mirrored: touched,
      skipped,
      valuesFingerprint: null,
      error: `Writing calculated values to OpenProject failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Reads, evaluates, stores and mirrors, recording the pass as it goes. A pass
 * that fails is recorded as failed and leaves the stored values as they were.
 */
export async function runCalculatedPass(trigger: CalculatedTrigger): Promise<CalculatedRunView> {
  const started = performance.now();
  const run = await prisma.calculatedRun.create({ data: { trigger } });
  const times: { readMs?: number; computeMs?: number; storeMs?: number; mirrorMs?: number } = {};
  const day = todayIso();

  try {
    const rows = await prisma.calculatedField.findMany({ orderBy: { createdAt: 'asc' } });
    const active = rows.filter((row) => row.active);
    const customIds = customIdsOf(rows);
    if (rows.length === 0) {
      // Nothing defined: values went with their definitions, and OpenProject's fields with them.
      const row = await prisma.calculatedRun.update({
        where: { id: run.id },
        data: { status: 'completed', finishedAt: new Date(), day, definitionsFingerprint: definitionsFingerprint(rows), durationMs: Math.round(performance.now() - started) },
      });
      return toRunView(row);
    }

    let at = performance.now();
    const inputs = await readInputs(customIds);
    times.readMs = Math.round(performance.now() - at);

    at = performance.now();
    const plans = plansFor(active, inputs, rows);
    const results = evaluateFields(plans, itemsOf(inputs), { today: day, calendar: calendarOf(inputs) });
    const projectOf = new Map(inputs.workPackages.map((wp) => [wp.id, wp.projectId]));
    const wanted: StoredValue[] = [];
    for (const row of active) {
      for (const [workPackageId, outcome] of results.get(row.id) ?? []) {
        wanted.push(storedOf(row, workPackageId, projectOf.get(workPackageId) ?? 0, outcome));
      }
    }
    times.computeMs = Math.round(performance.now() - at);

    at = performance.now();
    const stored = await storeValues(run.id, wanted);
    times.storeMs = Math.round(performance.now() - at);

    at = performance.now();
    const mirror = await mirrorValues(rows, inputs, results, customIds);
    times.mirrorMs = Math.round(performance.now() - at);

    const row = await prisma.calculatedRun.update({
      where: { id: run.id },
      data: {
        status: 'completed',
        finishedAt: new Date(),
        inputsFingerprint: inputs.fingerprint?.inputs ?? null,
        valuesFingerprint: mirror.valuesFingerprint,
        definitionsFingerprint: definitionsFingerprint(rows),
        day,
        fields: active.length,
        workPackages: inputs.workPackages.length,
        evaluated: wanted.length,
        empty: wanted.filter((value) => value.numberValue === null && value.dateValue === null && value.textValue === null && value.booleanValue === null).length,
        changed: stored.changed,
        removed: stored.removed,
        mirrored: mirror.mirrored,
        mirrorSkipped: mirror.skipped,
        mirrorError: mirror.error ?? null,
        ...times,
        durationMs: Math.round(performance.now() - started),
      },
    });
    return toRunView(row);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const row = await prisma.calculatedRun.update({
      where: { id: run.id },
      data: { status: 'failed', finishedAt: new Date(), day, error: text.slice(0, 2000), ...times, durationMs: Math.round(performance.now() - started) },
    });
    appLog.warn({ err: error, runId: run.id }, 'Calculated field pass failed; the stored values are unchanged');
    return toRunView(row);
  } finally {
    await pruneRuns().catch(() => undefined);
  }
}

async function pruneRuns(): Promise<void> {
  const cutoff = new Date(Date.now() - RUN_RETENTION_DAYS * 86_400_000);
  await prisma.calculatedRun.deleteMany({ where: { startedAt: { lt: cutoff }, status: { not: 'running' } } });
}

/* -------------------------------------------------------------------------- */
/* When a pass runs                                                           */
/* -------------------------------------------------------------------------- */

let running: Promise<CalculatedRunView | null> | null = null;
let again: CalculatedTrigger | null = null;
let timer: NodeJS.Timeout | undefined;

/** One pass here, behind the lease; null when another server holds it. */
async function leasedPass(trigger: CalculatedTrigger): Promise<CalculatedRunView | null> {
  const outcome = await withLease('calculated-pass', LEASE_MS, () => runCalculatedPass(trigger));
  if (outcome.ran) return outcome.result;
  // Another server is mid-pass and may have read the inputs before this change.
  const retry = runAsSystem(() => setTimeout(() => requestCalculatedRecalc(trigger), 5_000));
  retry.unref();
  return null;
}

/** Starts a pass now or, if one is running, makes sure another follows it. */
export function startCalculatedPass(trigger: CalculatedTrigger): Promise<CalculatedRunView | null> {
  if (running) {
    again = again === 'manual' ? again : trigger;
    return running;
  }
  running = (async () => {
    try {
      let outcome = await leasedPass(trigger);
      while (again) {
        const next = again;
        again = null;
        outcome = await leasedPass(next);
      }
      return outcome;
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * Queues a pass after a change: a work package, a relation, time, a
 * definition. Never awaited by the request that made the change; a burst
 * becomes one pass.
 */
export function requestCalculatedRecalc(trigger: CalculatedTrigger = 'change'): void {
  if (!env.EPM_CALCULATED_ENABLED) return;
  if (timer) clearTimeout(timer);
  // Out of whatever request queued this, so the timer cannot carry its token.
  timer = runAsSystem(() =>
    setTimeout(() => {
      timer = undefined;
      void startCalculatedPass(trigger).catch((error: unknown) => appLog.warn({ err: error }, 'Calculated field pass could not start'));
    }, DEBOUNCE_MS),
  );
  timer.unref();
}

/** A pass is queued or running in this process. */
export function calculatedPending(): boolean {
  return timer !== undefined || running !== null;
}

/** Resolves once nothing is queued or running here. */
export async function calculatedIdle(): Promise<void> {
  while (timer || running) {
    if (running) await running.catch(() => undefined);
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function lastCompletedCalculatedRun(): Promise<RunRow | null> {
  return prisma.calculatedRun.findFirst({ where: { status: 'completed' }, orderBy: { startedAt: 'desc' } });
}

/**
 * The check: has anything a formula reads moved since the last pass? One small
 * query on OpenProject, one row here; a pass only when the answer is yes.
 */
export async function checkCalculated(): Promise<{ ran: boolean; reason: string }> {
  if (running) return { ran: false, reason: 'a pass is running' };
  const rows = await prisma.calculatedField.findMany();
  const last = await lastCompletedCalculatedRun();
  if (rows.length === 0 && (!last || last.fields === 0)) return { ran: false, reason: 'no calculated fields' };
  const now = await readFingerprint(customIdsOf(rows));
  const reason = !last
    ? 'no pass yet'
    : last.definitionsFingerprint !== definitionsFingerprint(rows)
      ? 'the definitions changed'
      : last.inputsFingerprint !== now.inputs
        ? 'the inputs moved'
        : last.valuesFingerprint !== now.values
          ? "OpenProject's calculated fields differ from the values"
          : usesToday(rows) && last.day !== todayIso()
            ? 'the day changed'
            : null;
  if (!reason) return { ran: false, reason: 'nothing moved' };
  await startCalculatedPass(!last ? 'startup' : reason === 'the day changed' ? 'day' : 'check');
  return { ran: true, reason };
}

export async function calculatedStatus(): Promise<CalculatedStatus> {
  const [lastRun, lastCompleted] = await Promise.all([
    prisma.calculatedRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    lastCompletedCalculatedRun(),
  ]);
  return {
    enabled: env.EPM_CALCULATED_ENABLED,
    checkSeconds: env.EPM_CALCULATED_CHECK_SECONDS,
    pending: calculatedPending(),
    lastRun: lastRun ? toRunView(lastRun) : undefined,
    lastCompleted: lastCompleted ? toRunView(lastCompleted) : undefined,
  };
}

/** Records that somebody asked for a pass now. */
export async function noteManualRecalc(actorId: string): Promise<void> {
  await recordAuditQuietly([
    {
      actorId,
      entityType: 'calculated-field',
      entityId: 'all',
      action: 'calculated-field.recalculated',
      summary: message('Asked for every calculated field to be recalculated now.'),
    },
  ]);
}

/* -------------------------------------------------------------------------- */
/* Reading values                                                             */
/* -------------------------------------------------------------------------- */

/** One work package's calculated values, with the reason for each that is empty. */
export async function workPackageCalculatedValues(workPackageId: number): Promise<CalculatedValueView[]> {
  const rows = await prisma.calculatedValue.findMany({
    where: { workPackageId, field: { active: true } },
    include: { field: true },
    orderBy: { field: { name: 'asc' } },
  });
  return rows.map((row) => {
    const type = typeOfRow(row.field);
    const value =
      type === 'number' ? row.numberValue : type === 'date' ? (row.dateValue?.toISOString().slice(0, 10) ?? null) : type === 'text' ? row.textValue : row.booleanValue;
    return {
      fieldId: row.fieldId,
      key: row.field.key,
      name: row.field.name,
      resultType: type as CalculatedResultType,
      column: row.field.customFieldId === null ? undefined : `customField${row.field.customFieldId}`,
      value,
      reason: row.reason ? renderStored(row.reason, isMessage(row.reasonMessage) ? row.reasonMessage : undefined) : undefined,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Read-only to people                                                        */
/* -------------------------------------------------------------------------- */

/** The calculated fields by the attribute OpenProject's API names them by: `customField12`. */
async function calculatedColumns(): Promise<Map<string, FieldRow>> {
  const rows = await definitions();
  return new Map(rows.filter((row) => row.customFieldId !== null).map((row) => [`customField${row.customFieldId}`, row]));
}

/**
 * The `customFieldN` keys of every calculated field, switched off or not: worked
 * out for each work package, never copied onto one — a recurring series' new
 * task (task-series.ts) gets its own values from the next pass.
 */
export async function calculatedCustomFieldKeys(): Promise<string[]> {
  return [...(await calculatedColumns()).keys()];
}

/**
 * Refuses a write that sets a calculated field: EPM works its value out, so a
 * value typed in would only be overwritten by the next pass.
 */
export async function refuseCalculatedWrites(payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return;
  const record = payload as Record<string, unknown>;
  const keys = [...Object.keys(record), ...Object.keys((record._links as Record<string, unknown> | undefined) ?? {})].filter((key) =>
    /^customField\d+$/.test(key),
  );
  if (keys.length === 0) return;
  const columns = await calculatedColumns();
  const hit = keys.map((key) => columns.get(key)).find(Boolean);
  if (hit) {
    throw EpmError.validation(message('{field} is calculated by EPM from its formula, so it cannot be set by hand.', { field: hit.name }), {
      field: `customField${hit.customFieldId}`,
    });
  }
}

/**
 * A work package form with its calculated fields read-only: each is marked
 * not writable, carries its value and formula for showing, and leaves the
 * payload, so a form that echoes its payload back never writes one.
 */
export async function markCalculatedInForm<T extends { schema: Record<string, unknown>; payload: Record<string, unknown> }>(form: T): Promise<T> {
  const columns = await calculatedColumns().catch(() => new Map<string, FieldRow>());
  for (const [column, row] of columns) {
    const entry = form.schema[column];
    if (!entry || typeof entry !== 'object') continue;
    form.schema[column] = {
      ...(entry as Record<string, unknown>),
      writable: false,
      calculated: { key: row.key, expression: row.expression, resultType: typeOfRow(row), value: form.payload[column] ?? null },
    };
    delete form.payload[column];
  }
  return form;
}
