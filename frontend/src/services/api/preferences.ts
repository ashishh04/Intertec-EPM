import { apiClient } from './client';
import type { PreferenceRepository } from '../repositories';
import type { UserPreferences } from '@/types';

/**
 * The signed-in person's own preferences.
 *
 * Stored by the EPM backend rather than the browser so they follow the person
 * between devices, and so the email worker can honour them with no browser
 * open. A PUT carries only what changed; the server merges and returns the
 * whole record.
 */
export class ApiPreferenceRepository implements PreferenceRepository {
  get(): Promise<UserPreferences> {
    return apiClient.get<UserPreferences>('/preferences');
  }

  update(patch: Partial<UserPreferences>): Promise<UserPreferences> {
    return apiClient.request<UserPreferences>('/preferences', { method: 'PUT', body: patch });
  }
}
