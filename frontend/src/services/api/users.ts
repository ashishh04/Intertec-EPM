import { apiClient } from './client';
import type { UserRepository } from '../repositories';
import type { ID, EpmUser } from '@/types';

/** Reads EPM users, which the backend derives from OpenProject principals. */
export class ApiUserRepository implements UserRepository {
  getCurrentUser(): Promise<EpmUser> {
    return apiClient.get<EpmUser>('/me');
  }

  getUsers(): Promise<EpmUser[]> {
    return apiClient.get<EpmUser[]>('/users');
  }

  getUser(id: ID): Promise<EpmUser> {
    return apiClient.get<EpmUser>(`/users/${id}`);
  }
}
