import { apiClient } from './client';
import type { NotificationRepository } from '../repositories';
import type { ID, EpmNotification } from '@/types';

export class ApiNotificationRepository implements NotificationRepository {
  getNotifications(): Promise<EpmNotification[]> {
    return apiClient.get<EpmNotification[]>('/notifications');
  }

  async markRead(ids: ID[]): Promise<void> {
    await apiClient.patch<void>('/notifications/read', { ids });
  }

  async markAllRead(): Promise<void> {
    await apiClient.patch<void>('/notifications/read-all');
  }
}
