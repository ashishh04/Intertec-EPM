import { apiClient } from './client';
import type { ID } from '@/types';

/**
 * Watchers and relations on a work package.
 *
 * Both are related collections rather than fields, so they are kept off
 * `EpmTask` — folding them in would mean refetching a task to learn that
 * someone started watching it, and would invite a task → relation → task chain
 * that never terminates.
 */

export interface EpmWatcher {
  id: ID;
  name: string;
}

export interface EpmWatcherState {
  watchers: EpmWatcher[];
  /** Whether the signed-in user is watching. */
  isWatching: boolean;
  can: {
    add: boolean;
    /** Covers every watcher — OpenProject publishes no per-watcher permission. */
    remove: boolean;
    watchSelf: boolean;
  };
}

/**
 * A relation as the work package being viewed sees it.
 *
 * `type` and `label` are already stated from that point of view by the backend.
 * A stored `A blocks B` arrives as `blocks` when viewing A and `blocked by`
 * when viewing B, so nothing here has to reason about direction.
 */
export interface EpmRelation {
  id: ID;
  type: string;
  label: string;
  /** The work package at the other end — never the one being viewed. */
  related: { id: ID; subject: string };
  lag?: number;
  description?: string;
  can: { delete: boolean; update: boolean };
}

/** One direction a relation can be created in. */
export interface EpmRelationType {
  value: string;
  label: string;
}

export interface RelatableWorkPackage {
  id: ID;
  subject: string;
}

export class ApiWatcherRepository {
  get(workPackageId: ID): Promise<EpmWatcherState> {
    return apiClient.get<EpmWatcherState>(`/work-packages/${workPackageId}/watchers`);
  }

  available(workPackageId: ID): Promise<EpmWatcher[]> {
    return apiClient.get<EpmWatcher[]>(`/work-packages/${workPackageId}/available-watchers`);
  }

  add(workPackageId: ID, userId: ID): Promise<EpmWatcher> {
    return apiClient.post<EpmWatcher>(`/work-packages/${workPackageId}/watchers`, { userId });
  }

  remove(workPackageId: ID, userId: ID): Promise<void> {
    return apiClient.delete<void>(`/work-packages/${workPackageId}/watchers/${userId}`);
  }
}

export class ApiRelationRepository {
  list(workPackageId: ID): Promise<EpmRelation[]> {
    return apiClient.get<EpmRelation[]>(`/work-packages/${workPackageId}/relations`);
  }

  /**
   * The relation vocabulary, served by the backend rather than declared here.
   * It was established against the running OpenProject, and duplicating it in
   * the browser would let the two drift.
   */
  types(): Promise<EpmRelationType[]> {
    return apiClient.get<EpmRelationType[]>('/relation-types');
  }

  /** Candidate targets, searched upstream so the whole project is never loaded. */
  relatable(workPackageId: ID, term?: string): Promise<RelatableWorkPackage[]> {
    return apiClient.get<RelatableWorkPackage[]>(
      `/work-packages/${workPackageId}/relatable`,
      term ? { q: term } : undefined,
    );
  }

  create(workPackageId: ID, input: { type: string; relatedId: ID }): Promise<EpmRelation> {
    return apiClient.post<EpmRelation>(`/work-packages/${workPackageId}/relations`, input);
  }

  remove(relationId: ID): Promise<void> {
    return apiClient.delete<void>(`/relations/${relationId}`);
  }
}
