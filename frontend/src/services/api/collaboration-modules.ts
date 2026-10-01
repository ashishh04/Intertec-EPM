import { apiClient } from './client';
import type {
  EpmMeeting,
  EpmNewsPost,
  EpmWikiPage,
  ID,
  MeetingFilters,
  MeetingInput,
  NewsFilters,
  NewsInput,
  Paginated,
  WikiPageInput,
  WikiRevision,
  WikiTreeNode,
} from '@/types';

/**
 * Meetings, news and the wiki.
 *
 * Three repositories in one file because they are one thing: the collaboration
 * modules OpenProject has and does not expose, which EPM therefore owns
 * outright. Nothing behind these endpoints comes from upstream except the project
 * a record is scoped to and the people it names.
 *
 * `can` on every record is the backend's answer for that record, not a guess from
 * a permission: a person may edit their own meeting in a project where they may
 * not touch anybody else's, so the UI offers what the record says.
 */

export class ApiMeetingRepository {
  list(filters: MeetingFilters = {}): Promise<Paginated<EpmMeeting>> {
    return apiClient.get<Paginated<EpmMeeting>>('/meetings', { ...filters });
  }

  get(id: ID): Promise<EpmMeeting> {
    return apiClient.get<EpmMeeting>(`/meetings/${id}`);
  }

  create(input: MeetingInput): Promise<EpmMeeting> {
    return apiClient.post<EpmMeeting>('/meetings', input);
  }

  update(id: ID, input: Partial<MeetingInput>): Promise<EpmMeeting> {
    return apiClient.patch<EpmMeeting>(`/meetings/${id}`, input);
  }

  /**
   * Records who attended.
   *
   * Its own call, not part of `update`: the agenda is edited before a meeting and
   * attendance after it, and one request carrying both would let a late change to
   * the invite list discard attendance already recorded.
   */
  setAttendance(id: ID, attended: ID[]): Promise<EpmMeeting> {
    return apiClient.patch<EpmMeeting>(`/meetings/${id}/attendance`, { attended });
  }

  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/meetings/${id}`);
  }
}

export class ApiNewsRepository {
  list(filters: NewsFilters = {}): Promise<Paginated<EpmNewsPost>> {
    return apiClient.get<Paginated<EpmNewsPost>>('/news', {
      ...filters,
      // The backend reads this as a string flag, and only ever widens the set by
      // the caller's own drafts.
      ...(filters.includeDrafts ? { includeDrafts: 'true' } : {}),
    });
  }

  get(id: ID): Promise<EpmNewsPost> {
    return apiClient.get<EpmNewsPost>(`/news/${id}`);
  }

  create(input: NewsInput): Promise<EpmNewsPost> {
    return apiClient.post<EpmNewsPost>('/news', input);
  }

  update(id: ID, input: Partial<NewsInput>): Promise<EpmNewsPost> {
    return apiClient.patch<EpmNewsPost>(`/news/${id}`, input);
  }

  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/news/${id}`);
  }
}

export class ApiWikiRepository {
  /** Titles and slugs for the navigation tree. No bodies. */
  tree(projectId?: ID): Promise<WikiTreeNode[]> {
    return apiClient.get<WikiTreeNode[]>('/wiki/tree', projectId ? { projectId } : {});
  }

  /**
   * One page by its address.
   *
   * Slug rather than id, because that is what a wiki link is: somebody pastes
   * `/wiki/deployment` into a ticket and it has to keep working after the page is
   * renamed. The slug travels as a query parameter so one route serves both
   * scopes and a slug cannot break the path.
   */
  bySlug(slug: string, projectId?: ID): Promise<EpmWikiPage> {
    return apiClient.get<EpmWikiPage>('/wiki/page', { slug, ...(projectId ? { projectId } : {}) });
  }

  get(id: ID): Promise<EpmWikiPage> {
    return apiClient.get<EpmWikiPage>(`/wiki/pages/${id}`);
  }

  revisions(id: ID): Promise<WikiRevision[]> {
    return apiClient.get<WikiRevision[]>(`/wiki/pages/${id}/revisions`);
  }

  create(input: WikiPageInput): Promise<EpmWikiPage> {
    return apiClient.post<EpmWikiPage>('/wiki/pages', input);
  }

  update(id: ID, input: Partial<WikiPageInput>): Promise<EpmWikiPage> {
    return apiClient.patch<EpmWikiPage>(`/wiki/pages/${id}`, input);
  }

  /** Restores a past version as a new edit, so the restore itself is undoable. */
  restore(id: ID, revisionId: ID): Promise<EpmWikiPage> {
    return apiClient.post<EpmWikiPage>(`/wiki/pages/${id}/revisions/${revisionId}/restore`);
  }

  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/wiki/pages/${id}`);
  }
}
