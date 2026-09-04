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
import { ApiAttachmentRepository } from './api/attachments';
import { ApiQueryRepository } from './api/queries';
import { ApiCommentRepository } from './api/comments';
import { ApiDepartmentRepository } from './api/departments';
import { ApiAccountRepository } from './api/accounts';
import { ApiMemberRepository } from './api/members';
import { ApiEmployeeRepository } from './api/employees';
import { ApiAnalyticsRepository } from './api/analytics';
import { ApiPortfolioRepository } from './api/portfolios';
import { ApiRelationRepository, ApiWatcherRepository } from './api/collaboration';
import {
  ApiFormRepository,
  ApiProjectWriteRepository,
  ApiWorkPackageRepository,
} from './api/forms';

const repositories: EpmRepositories = {
  projects: new ApiProjectRepository(),
  tasks: new ApiTaskRepository(),
  users: new ApiUserRepository(),
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
/** EPM-owned, so outside the OpenProject-backed repository contract. */
export const teamService = new ApiTeamRepository();
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
export const queryService = new ApiQueryRepository();
export const attachmentService = new ApiAttachmentRepository();
export const watcherService = new ApiWatcherRepository();
export const relationService = new ApiRelationRepository();
export const commentService = new ApiCommentRepository();

/** Project membership. Writes through to OpenProject; EPM stores nothing. */
export const memberService = new ApiMemberRepository();

/** User accounts. Writes through to OpenProject; EPM stores no person. */
export const accountService = new ApiAccountRepository();

/** EPM-owned domains. Nothing behind these endpoints comes from OpenProject. */
export const departmentService = new ApiDepartmentRepository();
export const employeeService = new ApiEmployeeRepository();
export const portfolioService = new ApiPortfolioRepository();
export const analyticsService = new ApiAnalyticsRepository();

export type { EpmRepositories } from './repositories';
