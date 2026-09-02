import { apiClient } from './client';
import type { EpmTask, ID } from '@/types';

/**
 * Work package views, backed by OpenProject's Queries API through the EPM
 * backend.
 *
 * Filtering, sorting, grouping and paging all happen upstream. Nothing here
 * loads a dataset to filter it in the browser — that is the point of using
 * queries rather than the six filters this replaces.
 */

/** How many values an operator takes, read from the upstream schema. */
export type ValueArity = 'many' | 'single' | 'range';

export interface QueryOperatorSchema {
  /** The symbol OpenProject expects, e.g. `=`, `!`, `o`, `<>d`. */
  id: string;
  label: string;
  /** Absent when the operator needs no values at all — open, closed, empty. */
  valueType?: string;
  arity?: ValueArity;
  /** True when values are records rather than literals. */
  isResource?: boolean;
}

export interface QueryFilterSchema {
  id: string;
  name: string;
  operators: QueryOperatorSchema[];
}

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
  /** Absent for the default view, which is not persisted. */
  id?: ID;
  name: string;
  projectId?: ID;
  filters: QueryFilterInstance[];
  columns: QueryColumn[];
  sortBy: QuerySort[];
  groupBy?: string;
  sums: boolean;
  public: boolean;
  starred: boolean;
  updatedAt?: string;
  /** What this user may do with the view, as OpenProject reports it. */
  can: { update: boolean; delete: boolean; star: boolean; unstar: boolean };
}

export interface QueryResult {
  query: EpmQuery;
  tasks: EpmTask[];
  total: number;
  pageSize: number;
  page: number;
}

/** Parameters that override a view for one request without saving anything. */
export interface QueryOverrides {
  projectId?: ID;
  /** OpenProject filter JSON. Built by `buildFilters`. */
  filters?: string;
  sortBy?: string;
  groupBy?: string;
  offset?: number;
  pageSize?: number;
  showSums?: boolean;
}

/** Serializes filter instances into the JSON OpenProject expects. */
export function buildFilters(filters: QueryFilterInstance[]): string {
  return JSON.stringify(
    filters.map((filter) => ({
      [filter.id]: {
        operator: filter.operator,
        values: filter.values.map((value) => value.id),
      },
    })),
  );
}

export function buildSort(sorts: QuerySort[]): string {
  return JSON.stringify(sorts.map((sort) => [sort.field, sort.direction]));
}

export interface QuerySchemaResponse {
  filters: QueryFilterSchema[];
  columns: QueryColumn[];
  /**
   * Column ids OpenProject can sort by.
   *
   * Deliberately separate from `columns`: this instance renders spent time but
   * cannot sort by it, and can sort by category and duration without EPM having
   * anywhere to display them. Treating the two as one gets both wrong.
   */
  sortable: string[];
}

export class ApiQueryRepository {
  /**
   * Filters and columns available, project-scoped when a project is given.
   *
   * Both are instance configuration and both vary by project — a custom field
   * appears in each only within the projects that enable it.
   */
  getSchema(projectId?: ID): Promise<QuerySchemaResponse> {
    return apiClient.get<QuerySchemaResponse>('/queries/schema', { projectId });
  }

  /** Saved views the caller can see. */
  getQueries(projectId?: ID): Promise<EpmQuery[]> {
    return apiClient.get<EpmQuery[]>('/queries', { projectId });
  }

  /** The default view with overrides applied — the ad-hoc filtering path. */
  runDefault(overrides: QueryOverrides = {}): Promise<QueryResult> {
    return apiClient.get<QueryResult>('/queries/default', { ...overrides });
  }

  /** A saved view, with the same overrides available. */
  run(id: ID, overrides: QueryOverrides = {}): Promise<QueryResult> {
    return apiClient.get<QueryResult>(`/queries/${id}`, { ...overrides });
  }

  create(input: {
    name: string;
    projectId?: ID;
    payload?: Record<string, unknown>;
  }): Promise<EpmQuery> {
    return apiClient.post<EpmQuery>('/queries', input);
  }

  update(id: ID, patch: Record<string, unknown>): Promise<EpmQuery> {
    return apiClient.patch<EpmQuery>(`/queries/${id}`, patch);
  }

  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/queries/${id}`);
  }

  star(id: ID): Promise<EpmQuery> {
    return apiClient.patch<EpmQuery>(`/queries/${id}/star`);
  }

  unstar(id: ID): Promise<EpmQuery> {
    return apiClient.patch<EpmQuery>(`/queries/${id}/unstar`);
  }
}
