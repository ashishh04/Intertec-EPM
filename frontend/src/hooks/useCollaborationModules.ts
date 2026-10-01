import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { exceptDetailOf } from '@/lib/queryKeys';
import { meetingService, newsService, wikiService } from '@/services';
import type {
  ID,
  MeetingFilters,
  MeetingInput,
  NewsFilters,
  NewsInput,
  WikiPageInput,
} from '@/types';

/**
 * Meetings, news and the wiki.
 *
 * All three are EPM's own records, so a write invalidates only its own root —
 * nothing upstream changes, and none of the aggregates the dashboard and reports
 * are built from can move. That is the difference from `useTasks`, where one edit
 * ripples through five caches.
 */

export const meetingKeys = {
  all: ['meetings'] as const,
  list: (filters: MeetingFilters) => ['meetings', 'list', filters] as const,
  detail: (id: ID) => ['meetings', 'detail', id] as const,
};

export const newsKeys = {
  all: ['news'] as const,
  list: (filters: NewsFilters) => ['news', 'list', filters] as const,
  detail: (id: ID) => ['news', 'detail', id] as const,
};

export const wikiKeys = {
  all: ['wiki'] as const,
  tree: (projectId?: ID) => ['wiki', 'tree', projectId ?? 'organisation'] as const,
  page: (slug: string, projectId?: ID) =>
    ['wiki', 'page', projectId ?? 'organisation', slug] as const,
  revisions: (id: ID) => ['wiki', 'revisions', id] as const,
};

/* -------------------------------------------------------------------------- */
/* Meetings                                                                   */
/* -------------------------------------------------------------------------- */

export function useMeetings(filters: MeetingFilters = {}) {
  return useQuery({
    queryKey: meetingKeys.list(filters),
    queryFn: () => meetingService.list(filters),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
}

export function useMeeting(id?: ID) {
  return useQuery({
    queryKey: meetingKeys.detail(id ?? 'unknown'),
    queryFn: () => meetingService.get(id!),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

function useMeetingInvalidation() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: meetingKeys.all });
}

export function useCreateMeeting() {
  const settle = useMeetingInvalidation();
  return useMutation({
    mutationFn: (input: MeetingInput) => meetingService.create(input),
    onSuccess: settle,
  });
}

export function useUpdateMeeting() {
  const settle = useMeetingInvalidation();
  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: Partial<MeetingInput> }) =>
      meetingService.update(id, input),
    onSuccess: settle,
  });
}

export function useSetAttendance() {
  const settle = useMeetingInvalidation();
  return useMutation({
    mutationFn: ({ id, attended }: { id: ID; attended: ID[] }) =>
      meetingService.setAttendance(id, attended),
    onSuccess: settle,
  });
}

/**
 * Deletes a meeting.
 *
 * Its own invalidation rather than the shared one, because a delete has to spare
 * the record it just removed: `meetingKeys.detail(id)` sits under
 * `meetingKeys.all`, so a blanket invalidation refetches a meeting that no longer
 * exists and paints an error over the page the caller is about to leave.
 */
export function useDeleteMeeting() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: ID) => meetingService.remove(id),
    onSuccess: (_result, id) =>
      client.invalidateQueries({
        queryKey: meetingKeys.all,
        predicate: exceptDetailOf('meetings', id),
      }),
  });
}

/* -------------------------------------------------------------------------- */
/* News                                                                       */
/* -------------------------------------------------------------------------- */

export function useNews(filters: NewsFilters = {}) {
  return useQuery({
    queryKey: newsKeys.list(filters),
    queryFn: () => newsService.list(filters),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });
}

export function useNewsPost(id?: ID) {
  return useQuery({
    queryKey: newsKeys.detail(id ?? 'unknown'),
    queryFn: () => newsService.get(id!),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

function useNewsInvalidation() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: newsKeys.all });
}

export function useCreateNews() {
  const settle = useNewsInvalidation();
  return useMutation({
    mutationFn: (input: NewsInput) => newsService.create(input),
    onSuccess: settle,
  });
}

export function useUpdateNews() {
  const settle = useNewsInvalidation();
  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: Partial<NewsInput> }) =>
      newsService.update(id, input),
    onSuccess: settle,
  });
}

/** Deletes a post, sparing its own detail query for the reason above. */
export function useDeleteNews() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: ID) => newsService.remove(id),
    onSuccess: (_result, id) =>
      client.invalidateQueries({
        queryKey: newsKeys.all,
        predicate: exceptDetailOf('news', id),
      }),
  });
}

/* -------------------------------------------------------------------------- */
/* Wiki                                                                       */
/* -------------------------------------------------------------------------- */

export function useWikiTree(projectId?: ID) {
  return useQuery({
    queryKey: wikiKeys.tree(projectId),
    queryFn: () => wikiService.tree(projectId),
    staleTime: 60_000,
  });
}

/**
 * One page by slug.
 *
 * `retry: false` because the common failure is a page that does not exist — a
 * link to something never written, or a slug that changed — and the useful
 * response to that is an offer to create it, immediately, rather than after two
 * silent retries.
 */
export function useWikiPage(slug?: string, projectId?: ID) {
  return useQuery({
    queryKey: wikiKeys.page(slug ?? '', projectId),
    queryFn: () => wikiService.bySlug(slug!, projectId),
    enabled: Boolean(slug),
    staleTime: 30_000,
    retry: false,
  });
}

export function useWikiRevisions(id?: ID) {
  return useQuery({
    queryKey: wikiKeys.revisions(id ?? 'unknown'),
    queryFn: () => wikiService.revisions(id!),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

function useWikiInvalidation() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: wikiKeys.all });
}

export function useCreateWikiPage() {
  const settle = useWikiInvalidation();
  return useMutation({
    mutationFn: (input: WikiPageInput) => wikiService.create(input),
    onSuccess: settle,
  });
}

export function useUpdateWikiPage() {
  const settle = useWikiInvalidation();
  return useMutation({
    mutationFn: ({ id, input }: { id: ID; input: Partial<WikiPageInput> }) =>
      wikiService.update(id, input),
    onSuccess: settle,
  });
}

export function useRestoreWikiRevision() {
  const settle = useWikiInvalidation();
  return useMutation({
    mutationFn: ({ id, revisionId }: { id: ID; revisionId: ID }) =>
      wikiService.restore(id, revisionId),
    onSuccess: settle,
  });
}

export function useDeleteWikiPage() {
  const settle = useWikiInvalidation();
  return useMutation({
    mutationFn: (id: ID) => wikiService.remove(id),
    onSuccess: settle,
  });
}
