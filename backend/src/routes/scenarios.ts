import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { adjustScenario, captureScenario, deleteScenario, listScenarios, scenarioView, submitScenario } from '../domain/scenarios-store.js';
import { viewerOf } from './measures.js';

/**
 * Portfolio scenarios (Module 7: BR-220 to BR-222), for whoever holds
 * `scenarios:manage`. Applying one to live data happens only when its
 * approval request is approved (Approvals).
 */
export const scenarioRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request) => {
    await guard.require(request, 'scenarios:manage');
  });

  app.get('/scenarios', async () => listScenarios());

  app.post<{ Body: unknown }>('/scenarios', async (request, reply) => {
    const viewer = await viewerOf(request);
    reply.code(201);
    return captureScenario(request.body, request.auth!.userId, viewer.visibleProjectIds);
  });

  app.get<{ Params: { id: string } }>('/scenarios/:id', async (request) => scenarioView(request.params.id));

  app.patch<{ Params: { id: string; projectId: string }; Body: unknown }>('/scenarios/:id/projects/:projectId', async (request) =>
    adjustScenario(request.params.id, Number(request.params.projectId), request.body, request.auth!.userId),
  );

  app.post<{ Params: { id: string } }>('/scenarios/:id/submit', async (request) => submitScenario(request.params.id, request.auth!.userId));

  app.delete<{ Params: { id: string } }>('/scenarios/:id', async (request, reply) => {
    await deleteScenario(request.params.id, request.auth!.userId);
    reply.code(204);
  });
};
