/**
 * Service facade.
 *
 * Components and hooks import from here and never construct a repository or
 * touch `fetch` themselves. Every domain is served by the EPM backend, which is
 * the only source of data in the app.
 */

import type { EpmRepositories } from './repositories';

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
import { ApiCatalogRepository } from './api/catalog';
import {
  ApiFormRepository,
  ApiProjectWriteRepository,
  ApiWorkPackageRepository,
} from './api/forms';

const repositories: EpmRepositories = {
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

/**
 * Reference data and schema live outside the domain-model contract: they carry
 * OpenProject's real ids and field definitions rather than EPM's normalized
 * view, which is exactly what write paths and pickers need.
 */
export const catalogService = new ApiCatalogRepository();
export const formService = new ApiFormRepository();
export const workPackageService = new ApiWorkPackageRepository();
export const projectWriteService = new ApiProjectWriteRepository();

export type { EpmRepositories } from './repositories';
