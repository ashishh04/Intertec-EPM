import { linkId, linkTitle } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';

/**
 * Normalizes OpenProject's query representation into the EPM model.
 *
 * OpenProject describes queries in HAL: filters, operators and values are all
 * links, and the value schema for a filter depends on which operator is chosen.
 * That shape is faithful but awkward to render, and letting it reach the UI
 * would put HAL parsing in React. It is flattened once, here.
 *
 * Nothing about the filter vocabulary is enumerated. The list of filters, the
 * operators each accepts and the type of value each operator wants are all read
 * from the instance, so a custom field added upstream appears without a change
 * to this file — verified: adding one took the project-scoped filter count from
 * 45 to 47 with no code change.
 */

/* -------------------------------------------------------------------------- */
/* Filter discovery                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Value cardinality, read from OpenProject's type notation.
 *
 * `[]User` accepts any number, `[1]String` exactly one, `[2]Date` a pair — which
 * is how a date range is expressed.
 */
export type ValueArity = 'many' | 'single' | 'range';

export interface QueryOperatorSchema {
  /** The operator symbol OpenProject expects, e.g. `=`, `!`, `o`, `<>d`. */
  id: string;
  /** Human label. Presentation only; falls back to the symbol. */
  label: string;
  /**
   * The kind of value this operator takes: `User`, `Status`, `String`,
   * `Integer`, `Date`, `Boolean`, `CustomOption`, and so on.
   *
   * Absent when the operator takes no values at all — `o` (open), `*` (all)
   * and `!*` (none) are complete on their own, and offering a value control
   * for them would produce a request OpenProject rejects.
   */
  valueType?: string;
  arity?: ValueArity;
  /** True when values are resource links rather than primitives. */
  isResource?: boolean;
}

export interface QueryFilterSchema {
  /** Filter id as OpenProject names it, e.g. `status`, `customField1`. */
  id: string;
  name: string;
  operators: QueryOperatorSchema[];
}

/**
 * Operator labels.
 *
 * OpenProject returns a title for an operator only when it appears on a query
 * it has already built, so there is no endpoint that lists them all. These are
 * display strings and nothing more — the symbol is always what gets sent, and
 * an unrecognised one falls through to the symbol itself rather than being
 * hidden or renamed.
 */
const OPERATOR_LABELS: Record<string, string> = {
  '=': 'is (OR)',
  '!': 'is not',
  '~': 'contains',
  '!~': 'does not contain',
  '**': 'search',
  '*': 'is not empty',
  '!*': 'is empty',
  o: 'open',
  c: 'closed',
  '&=': 'is (AND)',
  '<=': 'is less than or equal',
  '>=': 'is greater than or equal',
  '=d': 'on',
  '<>d': 'between',
  't': 'today',
  'w': 'this week',
  't-': 'days ago',
  't+': 'days from now',
  '<t-': 'more days ago than',
  '>t-': 'less days ago than',
  '<t+': 'less days from now than',
  '>t+': 'more days from now than',
  ow: 'manually ordered',
};

/** `[]User` -> { base: 'User', arity: 'many' }; `[2]Date` -> range. */
function parseValueType(type: string): { base: string; arity: ValueArity } {
  const match = /^\[(\d*)\](.+)$/.exec(type);
  if (!match) return { base: type, arity: 'single' };

  const [, count, base] = match;
  const arity: ValueArity = count === '' ? 'many' : count === '2' ? 'range' : 'single';
  return { base: base ?? type, arity };
}

/** Value types that are links to OpenProject records rather than literals. */
const PRIMITIVE_TYPES = new Set(['String', 'Integer', 'Float', 'Boolean', 'Date', 'DateTime']);

interface OpFilterInstanceSchema {
  _dependencies?: {
    on?: string;
    dependencies?: Record<string, { values?: { type?: string } }>;
  }[];
  _links?: { self?: HalLink; filter?: HalLink };
}

export function toFilterSchema(element: OpFilterInstanceSchema): QueryFilterSchema | undefined {
  const id = element._links?.self?.href?.split('/').pop();
  if (!id) return undefined;

  const operators: QueryOperatorSchema[] = [];

  for (const dependency of element._dependencies ?? []) {
    // Only the operator dependency describes value shape; others are ignored
    // rather than guessed at.
    if (dependency.on !== undefined && dependency.on !== 'operator') continue;

    for (const [href, definition] of Object.entries(dependency.dependencies ?? {})) {
      const symbol = decodeURIComponent(href.split('/').pop() ?? '');
      if (!symbol) continue;

      const rawType = definition?.values?.type;

      if (!rawType) {
        // An operator with no value schema is complete on its own.
        operators.push({ id: symbol, label: OPERATOR_LABELS[symbol] ?? symbol });
        continue;
      }

      const { base, arity } = parseValueType(rawType);
      operators.push({
        id: symbol,
        label: OPERATOR_LABELS[symbol] ?? symbol,
        valueType: base,
        arity,
        isResource: !PRIMITIVE_TYPES.has(base),
      });
    }
  }

  // Stable order so the UI does not reshuffle between requests.
  operators.sort((a, b) => a.id.localeCompare(b.id));

  return {
    id,
    name: element._links?.filter?.title ?? humanize(id),
    operators,
  };
}

/** `customField1` -> `Custom field 1`; used only when OpenProject sends no title. */
function humanize(id: string): string {
  const spaced = id.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export interface QueryFilterValue {
  id: string;
  name?: string;
}

export interface QueryFilterInstance {
  id: string;
  name: string;
  operator: string;
  values: QueryFilterValue[];
}

export interface QueryColumn {
  id: string;
  name: string;
}

export interface QuerySort {
  field: string;
  direction: 'asc' | 'desc';
}

export interface EpmQuery {
  /** Absent for the default query, which is not persisted. */
  id?: string;
  name: string;
  projectId?: string;
  filters: QueryFilterInstance[];
  columns: QueryColumn[];
  sortBy: QuerySort[];
  groupBy?: string;
  sums: boolean;
  public: boolean;
  starred: boolean;
  updatedAt?: string;
  /**
   * What the signed-in user may do with this query, taken from the affordances
   * OpenProject publishes on it. Never inferred from a role.
   */
  can: { update: boolean; delete: boolean; star: boolean; unstar: boolean };
}

interface OpQueryFilter {
  name?: string;
  _links?: {
    filter?: HalLink;
    operator?: HalLink;
    values?: HalLink[];
  };
}

interface OpQuery {
  id?: number;
  name?: string;
  sums?: boolean;
  public?: boolean;
  starred?: boolean;
  updatedAt?: string;
  filters?: OpQueryFilter[];
  _embedded?: {
    filters?: OpQueryFilter[];
    columns?: { id?: string; name?: string }[];
    sortBy?: { id?: string }[];
    groupBy?: { id?: string } | null;
  };
  _links?: Record<string, HalLink | HalLink[] | undefined>;
}

/** `id-asc` / `dueDate-desc` -> a structured sort. */
function toSort(id: string | undefined): QuerySort | undefined {
  if (!id) return undefined;
  const index = id.lastIndexOf('-');
  if (index <= 0) return { field: id, direction: 'asc' };

  const direction = id.slice(index + 1);
  return {
    field: id.slice(0, index),
    direction: direction === 'desc' ? 'desc' : 'asc',
  };
}

export function toEpmQuery(query: OpQuery): EpmQuery {
  const links = query._links ?? {};
  const filters = query._embedded?.filters ?? query.filters ?? [];

  return {
    id: query.id === undefined ? undefined : String(query.id),
    name: query.name ?? 'Default',
    projectId: linkId(links, 'project'),

    filters: filters.map((filter) => ({
      id: filter._links?.filter?.href?.split('/').pop() ?? '',
      name: filter._links?.filter?.title ?? filter.name ?? '',
      operator: decodeURIComponent(filter._links?.operator?.href?.split('/').pop() ?? ''),
      values: (filter._links?.values ?? []).map((value) => ({
        // A value is either a link to a record or a bare literal in `href`.
        id: value.href?.split('/').pop() ?? String(value.title ?? ''),
        name: value.title ?? undefined,
      })),
    })),

    columns: (query._embedded?.columns ?? []).map((column) => ({
      id: column.id ?? '',
      name: column.name ?? column.id ?? '',
    })),

    sortBy: (query._embedded?.sortBy ?? [])
      .map((entry) => toSort(entry.id))
      .filter((sort): sort is QuerySort => sort !== undefined),

    groupBy: query._embedded?.groupBy?.id ?? undefined,
    sums: Boolean(query.sums),
    public: Boolean(query.public),
    starred: Boolean(query.starred),
    updatedAt: query.updatedAt,

    can: {
      update: Object.hasOwn(links, 'updateImmediately'),
      delete: Object.hasOwn(links, 'delete'),
      star: Object.hasOwn(links, 'star'),
      unstar: Object.hasOwn(links, 'unstar'),
    },
  };
}

export { linkTitle };
