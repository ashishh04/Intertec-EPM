import type { FastifyPluginAsync } from 'fastify';

import { attachmentRoutes } from './attachments.js';
import { authRoutes } from './auth.js';
import { catalogRoutes } from './catalog.js';
import { commentRoutes } from './comments.js';
import { dashboardRoutes } from './dashboard.js';
import { departmentRoutes } from './departments.js';
import { employeeRoutes } from './employees.js';
import { documentRoutes } from './documents.js';
import { formRoutes } from './forms.js';
import { integrationRoutes } from './integrations.js';
import { notificationRoutes } from './notifications.js';
import { projectRoutes } from './projects.js';
import { queryRoutes } from './queries.js';
import { relationRoutes } from './relations.js';
import { reportRoutes } from './reports.js';
import { sprintRoutes } from './sprints.js';
import { taskRoutes } from './tasks.js';
import { teamRoutes } from './teams.js';
import { userRoutes } from './users.js';
import { watcherRoutes } from './watchers.js';
import { workPackageRoutes } from './work-packages.js';

/**
 * The EPM API surface.
 *
 * The contract is `frontend/src/services/api/*` — each Api*Repository there is
 * the spec for one group registered here.
 */
export const registerRoutes: FastifyPluginAsync = async (app) => {
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(projectRoutes);
  await app.register(taskRoutes);
  await app.register(teamRoutes);
  await app.register(sprintRoutes);
  await app.register(dashboardRoutes);
  await app.register(reportRoutes);
  await app.register(notificationRoutes);
  await app.register(documentRoutes);
  await app.register(integrationRoutes);
  await app.register(catalogRoutes);
  await app.register(formRoutes);
  await app.register(workPackageRoutes);
  await app.register(attachmentRoutes);
  await app.register(queryRoutes);
  await app.register(watcherRoutes);
  await app.register(relationRoutes);
  await app.register(commentRoutes);
  await app.register(departmentRoutes);
  await app.register(employeeRoutes);
};
