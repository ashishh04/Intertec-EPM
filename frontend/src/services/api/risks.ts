import { apiClient } from './client';
import type { ID, MilestoneEntry, RiskAssessmentInput, RiskEntry, RiskRegister } from '@/types';

/**
 * The risk register, and milestones across projects.
 *
 * A risk is a work package of a risk type, created and edited through the task
 * endpoints like any other; what the register adds is its assessment. Both
 * lists hold only what the reader may see.
 */

export interface RiskListOptions {
  projectId?: ID;
  state?: 'open' | 'closed' | 'all';
}

export interface MilestoneListOptions {
  projectId?: ID;
  state?: 'open' | 'closed' | 'all';
}

export class ApiRiskRepository {
  setup(): Promise<Pick<RiskRegister, 'configured' | 'typeIds'>> {
    return apiClient.get<Pick<RiskRegister, 'configured' | 'typeIds'>>('/risks/setup');
  }

  register(options: RiskListOptions = {}): Promise<RiskRegister> {
    return apiClient.get<RiskRegister>('/risks', {
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.state ? { state: options.state } : {}),
    });
  }

  saveAssessment(workPackageId: ID, input: RiskAssessmentInput): Promise<RiskEntry> {
    return apiClient.put<RiskEntry>(`/risks/${workPackageId}/assessment`, input);
  }

  milestones(options: MilestoneListOptions = {}): Promise<MilestoneEntry[]> {
    return apiClient.get<MilestoneEntry[]>('/milestones', {
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.state ? { state: options.state } : {}),
    });
  }
}
