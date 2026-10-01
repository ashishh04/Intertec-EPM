import { apiClient } from './client';
import type {
  CreateTimeEntryInput,
  EpmTimeEntry,
  ID,
  Paginated,
  TimeEntryFilters,
  TimeReport,
  TimeReportFilters,
  UpdateTimeEntryInput,
} from '@/types';

/**
 * Logged time.
 *
 * Authorised upstream rather than by EPM's permission map — time entries have
 * no action in OpenProject's capabilities vocabulary, so the instance is asked
 * at the point of the write and its refusal is what comes back. A 403 here is
 * a real answer with a real reason, not a bug.
 */
export class ApiTimeEntryRepository {
  list(filters: TimeEntryFilters = {}): Promise<Paginated<EpmTimeEntry>> {
    return apiClient.get<Paginated<EpmTimeEntry>>('/time-entries', { ...filters });
  }

  get(id: ID): Promise<EpmTimeEntry> {
    return apiClient.get<EpmTimeEntry>(`/time-entries/${id}`);
  }

  /**
   * The people the report's person filter may offer.
   *
   * Not the directory. OpenProject's time-entry `user` filter only accepts
   * principals it could show time for — members of a project — and rejects
   * anybody else outright, so a picker built from `/users` offered choices that
   * could only fail.
   */
  people(): Promise<{ id: ID; name: string }[]> {
    return apiClient.get<{ id: ID; name: string }[]>('/time-entries/people');
  }

  /**
   * Hours and cost over a range, grouped upstream.
   *
   * Aggregated on the server on purpose: a quarter is thousands of entries, and
   * summing them here would be wrong on every page but the last.
   */
  report(filters: TimeReportFilters): Promise<TimeReport> {
    return apiClient.get<TimeReport>('/time-entries/report', { ...filters });
  }

  create(input: CreateTimeEntryInput): Promise<EpmTimeEntry> {
    return apiClient.post<EpmTimeEntry>('/time-entries', input);
  }

  update(id: ID, input: UpdateTimeEntryInput): Promise<EpmTimeEntry> {
    return apiClient.patch<EpmTimeEntry>(`/time-entries/${id}`, input);
  }

  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/time-entries/${id}`);
  }
}
