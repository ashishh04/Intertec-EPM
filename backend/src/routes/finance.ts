import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { allows } from '../auth/capabilities.js';
import * as guard from '../auth/guard.js';
import { addRate, currencies, listRates } from '../domain/currency.js';
import {
  batchWorkbook,
  billingView,
  cashFlowFor,
  createBatch,
  deleteRateCard,
  forecastFor,
  generateBilling,
  getBatch,
  getContract,
  getFinanceSettings,
  listBatches,
  listMilestones,
  listRateCards,
  marginFor,
  projectPhasing,
  removeMilestone,
  resetPhasing,
  saveFinanceSettings,
  savePhasing,
  saveRateCard,
  sendBatch,
  setMilestone,
  updateContract,
} from '../domain/finance-store.js';
import { modelFacts } from '../domain/measure-facts.js';
import { EpmError } from '../lib/errors.js';
import type { Permission } from '../types/epm.js';
import { contentDispositionFor } from '../lib/uploads.js';
import { viewerOf } from './measures.js';

/**
 * Finance (Module 11, part 2): phasing and cash flow, margin and forecast,
 * billing and its transfer. Reading needs `finance:view`; contracts, phasing
 * and billing `finance:manage`; rates, rate cards and settings
 * `finance:configure`. A project is read only by those who can see it.
 */

async function requireAny(request: FastifyRequest, permissions: Permission[]): Promise<void> {
  const held = await guard.permissionsFor(request);
  if (!permissions.some((permission) => allows(held, permission))) {
    throw EpmError.forbidden('This needs one of the finance permissions.');
  }
}

/** A project the caller may see, as a number. */
async function projectOf(request: FastifyRequest, raw: string, permission: Permission): Promise<number> {
  const projectId = Number(raw);
  if (!Number.isInteger(projectId) || projectId <= 0) throw EpmError.notFound('That project');
  await guard.require(request, permission);
  await guard.require(request, 'project:view', String(projectId));
  return projectId;
}

/** The projects a figure covers: one, a portfolio's, or every active one the caller can see. */
async function scopeOf(request: FastifyRequest): Promise<number[]> {
  await guard.require(request, 'finance:view');
  const query = request.query as { projectId?: string; portfolioId?: string };
  const viewer = await viewerOf(request);
  if (query.projectId) {
    const projectId = Number(query.projectId);
    if (!Number.isInteger(projectId) || !viewer.visibleProjectIds.has(projectId)) throw EpmError.notFound('That project');
    return [projectId];
  }
  const facts = await modelFacts();
  if (query.portfolioId) {
    if (!facts.portfolios.has(query.portfolioId)) throw EpmError.notFound('That portfolio');
    return [...facts.projects.values()]
      .filter((project) => project.portfolioId === query.portfolioId && viewer.visibleProjectIds.has(project.id))
      .map((project) => project.id);
  }
  return [...facts.projects.values()].filter((project) => project.active && viewer.visibleProjectIds.has(project.id)).map((project) => project.id);
}

export const financeRoutes: FastifyPluginAsync = async (app) => {
  /* ------------------------------------------------------------- settings */

  app.get('/finance/settings', async (request) => {
    await requireAny(request, ['finance:view', 'finance:configure']);
    return getFinanceSettings();
  });

  app.put<{ Body: unknown }>('/finance/settings', async (request) => {
    await guard.require(request, 'finance:configure');
    return saveFinanceSettings(request.body, request.auth!.userId);
  });

  /* ----------------------------------------------------------- currencies */

  /** Any signed-in person: a claim can be made in any of them. */
  app.get('/finance/currencies', async () => currencies());

  app.get('/finance/rates', async (request) => {
    await requireAny(request, ['finance:view', 'finance:configure']);
    return listRates();
  });

  app.post<{ Body: unknown }>('/finance/rates', async (request, reply) => {
    await guard.require(request, 'finance:configure');
    reply.code(201);
    return addRate(request.body, request.auth!.userId);
  });

  /* ----------------------------------------------------------- rate cards */

  app.get('/finance/rate-cards', async (request) => {
    await requireAny(request, ['finance:view', 'finance:manage', 'finance:configure']);
    return listRateCards();
  });

  app.post<{ Body: unknown }>('/finance/rate-cards', async (request, reply) => {
    await guard.require(request, 'finance:configure');
    reply.code(201);
    return saveRateCard(null, request.body, request.auth!.userId);
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/finance/rate-cards/:id', async (request) => {
    await guard.require(request, 'finance:configure');
    return saveRateCard(request.params.id, request.body, request.auth!.userId);
  });

  app.delete<{ Params: { id: string } }>('/finance/rate-cards/:id', async (request, reply) => {
    await guard.require(request, 'finance:configure');
    await deleteRateCard(request.params.id, request.auth!.userId);
    reply.code(204);
  });

  /* --------------------------------------------------- project: contract */

  app.get<{ Params: { projectId: string } }>('/finance/projects/:projectId/contract', async (request) =>
    getContract(await projectOf(request, request.params.projectId, 'finance:view')),
  );

  app.patch<{ Params: { projectId: string }; Body: unknown }>('/finance/projects/:projectId/contract', async (request) =>
    updateContract(await projectOf(request, request.params.projectId, 'finance:manage'), request.body, request.auth!.userId),
  );

  /* ---------------------------------------------- project: phasing (BR-310) */

  app.get<{ Params: { projectId: string } }>('/finance/projects/:projectId/phasing', async (request) =>
    projectPhasing(await projectOf(request, request.params.projectId, 'finance:view')),
  );

  app.put<{ Params: { projectId: string }; Body: unknown }>('/finance/projects/:projectId/phasing', async (request) =>
    savePhasing(await projectOf(request, request.params.projectId, 'finance:manage'), request.body, request.auth!.userId),
  );

  /** Back to the phasing derived from the schedule. */
  app.delete<{ Params: { projectId: string } }>('/finance/projects/:projectId/phasing', async (request) =>
    resetPhasing(await projectOf(request, request.params.projectId, 'finance:manage'), request.auth!.userId),
  );

  /* ------------------------------------- figures: cash flow, margin, forecast */

  app.get('/finance/cash-flow', async (request) => cashFlowFor(await scopeOf(request)));
  app.get('/finance/margin', async (request) => marginFor(await scopeOf(request)));
  app.get('/finance/forecast', async (request) => forecastFor(await scopeOf(request)));

  /* ------------------------------------------ project: billing (BR-322) */

  app.get<{ Params: { projectId: string } }>('/finance/projects/:projectId/milestones', async (request) =>
    listMilestones(await projectOf(request, request.params.projectId, 'finance:view')),
  );

  app.put<{ Params: { projectId: string; workPackageId: string }; Body: unknown }>(
    '/finance/projects/:projectId/milestones/:workPackageId',
    async (request) =>
      setMilestone(
        await projectOf(request, request.params.projectId, 'finance:manage'),
        Number(request.params.workPackageId),
        request.body,
        request.auth!.userId,
      ),
  );

  app.delete<{ Params: { projectId: string; workPackageId: string } }>('/finance/projects/:projectId/milestones/:workPackageId', async (request) =>
    removeMilestone(await projectOf(request, request.params.projectId, 'finance:manage'), Number(request.params.workPackageId), request.auth!.userId),
  );

  app.get<{ Params: { projectId: string }; Querystring: { from?: string; to?: string } }>('/finance/projects/:projectId/billing', async (request) =>
    billingView(await projectOf(request, request.params.projectId, 'finance:view'), request.query),
  );

  app.post<{ Params: { projectId: string }; Body: { from?: string; to?: string } }>('/finance/projects/:projectId/billing', async (request) =>
    generateBilling(await projectOf(request, request.params.projectId, 'finance:manage'), request.body ?? {}, request.auth!.userId),
  );

  /* ------------------------------------------------ batches (BR-323) */

  app.get('/finance/batches', async (request) => {
    await guard.require(request, 'finance:view');
    return listBatches();
  });

  app.post<{ Body: unknown }>('/finance/batches', async (request, reply) => {
    await guard.require(request, 'finance:manage');
    const body = (request.body ?? {}) as { projectId?: unknown };
    if (body.projectId !== undefined) await guard.require(request, 'project:view', String(body.projectId));
    reply.code(201);
    return createBatch(request.body, request.auth!.userId);
  });

  app.get<{ Params: { id: string } }>('/finance/batches/:id', async (request) => {
    await guard.require(request, 'finance:view');
    return getBatch(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/finance/batches/:id/send', async (request) => {
    await guard.require(request, 'finance:manage');
    return sendBatch(request.params.id, request.auth!.userId, false);
  });

  /** Sends a batch again, under the same ids: the finance system must not take it twice. */
  app.post<{ Params: { id: string } }>('/finance/batches/:id/replay', async (request) => {
    await guard.require(request, 'finance:manage');
    return sendBatch(request.params.id, request.auth!.userId, true);
  });

  app.get<{ Params: { id: string } }>('/finance/batches/:id/export', async (request, reply) => {
    await guard.require(request, 'finance:view');
    const { filename, content } = await batchWorkbook(request.params.id);
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', contentDispositionFor(filename))
      .header('Cache-Control', 'private, no-store');
    return reply.send(Buffer.from(content));
  });
};
