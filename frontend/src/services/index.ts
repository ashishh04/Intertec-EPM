/**
 * Service facade.
 *
 * Components and hooks import from here and never construct a repository or
 * touch `fetch` themselves. Flipping `VITE_DATA_SOURCE` from `mock` to `api` is
 * the entire migration to a live Nexus backend.
 */

import { env } from '@/config/env';
import type { NexusRepositories } from './repositories';

import { ApiProjectRepository } from './api/projects';
import { ApiTaskRepository } from './api/tasks';
import { ApiUserRepository } from './api/users';
import { ApiTeamRepository } from './api/teams';
import { ApiSprintRepository } from './api/sprints';
import { ApiDashboardRepository } from './api/dashboard';
import { ApiReportRepository } from './api/reports';
import { ApiNotificationRepository } from './api/notifications';
import { ApiDocumentRepository } from './api/documents';
import { ApiIntegrationRepository } from './api/integration';

import {
  MockDashboardRepository,
  MockDocumentRepository,
  MockIntegrationRepository,
  MockNotificationRepository,
  MockProjectRepository,
  MockReportRepository,
  MockSprintRepository,
  MockTaskRepository,
  MockTeamRepository,
  MockUserRepository,
} from './mock';

const mockRepositories: NexusRepositories = {
  projects: new MockProjectRepository(),
  tasks: new MockTaskRepository(),
  users: new MockUserRepository(),
  teams: new MockTeamRepository(),
  sprints: new MockSprintRepository(),
  dashboard: new MockDashboardRepository(),
  reports: new MockReportRepository(),
  notifications: new MockNotificationRepository(),
  documents: new MockDocumentRepository(),
  integration: new MockIntegrationRepository(),
};

const apiRepositories: NexusRepositories = {
  projects: new ApiProjectRepository(),
  tasks: new ApiTaskRepository(),
  users: new ApiUserRepository(),
  teams: new ApiTeamRepository(),
  sprints: new ApiSprintRepository(),
  dashboard: new ApiDashboardRepository(),
  reports: new ApiReportRepository(),
  notifications: new ApiNotificationRepository(),
  documents: new ApiDocumentRepository(),
  integration: new ApiIntegrationRepository(),
};

const repositories: NexusRepositories =
  env.dataSource === 'api' ? apiRepositories : mockRepositories;

export const projectService = repositories.projects;
export const taskService = repositories.tasks;
export const userService = repositories.users;
export const teamService = repositories.teams;
export const sprintService = repositories.sprints;
export const dashboardService = repositories.dashboard;
export const reportService = repositories.reports;
export const notificationService = repositories.notifications;
export const documentService = repositories.documents;
export const integrationService = repositories.integration;

export type { NexusRepositories } from './repositories';
