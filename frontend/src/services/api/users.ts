import { apiClient } from './client';
import type { UserRepository } from '../repositories';
import type { ID, NexusUser } from '@/types';

/** Reads Nexus users, which the backend derives from OpenProject principals. */
export class ApiUserRepository implements UserRepository {
  getCurrentUser(): Promise<NexusUser> {
    return apiClient.get<NexusUser>('/me');
  }

  getUsers(): Promise<NexusUser[]> {
    return apiClient.get<NexusUser[]>('/users');
  }

  getUser(id: ID): Promise<NexusUser> {
    return apiClient.get<NexusUser>(`/users/${id}`);
  }
}
