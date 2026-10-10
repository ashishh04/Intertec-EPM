import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { anywhere } from '../auth/capabilities.js';
import * as guard from '../auth/guard.js';
import { earningMethodsIn } from '../domain/earned-value.js';
import {
  evaluateProjects,
  getEvmSettings,
  listBaselines,
  loadEvmShared,
  methodOf,
  saveEvmSettings,
  setBaseline,
  type ProjectEvaluation,
} from '../domain/earned-value-store.js';
import { modelFacts, workFactsAsAt } from '../domain/measure-facts.js';
import { loadResourceShared } from '../domain/resources-store.js';
import { contextFor, type Shared } from '../domain/measures.js';
import { today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { message, msg, requestLanguage, t, type Message } from '../lib/i18n.js';
import { getCatalog } from '../mapping/catalog.js';
import { scopeOf, viewerOf } from './measures.js';

/**
 * Earned value (BRQ-12: BR-301 to BR-303).
 *
 * The figures themselves are measures (`evm.*`), on the Earned value dashboard
 * and every other place measures go. Here: the earning rules, each project's
 * baselines, one work package's figures, and a scope's figures as at any
 * moment — what the dashboard said, or would have said, then.
 */

const numeric = (value: string, what: Message) => {
  if (!/^\d+$/.test(value)) throw EpmError.notFound(what);
  return value;
};

const ids = (project: ProjectEvaluation, withItems: boolean) => ({
  projectId: String(project.projectId),
  measuredAgainst: project.measuredAgainst,
  totals: project.evaluation.totals,
  ...(withItems
    ? {
        items: project.evaluation.items.map((item) => ({
          ...item,
          workPackageId: String(item.workPackageId),
          projectId: String(item.projectId),
        })),
      }
    : {}),
});

export const earnedValueRoutes: FastifyPluginAsync = async (app) => {
  /** The rules in force, with the types and rules there are to choose from. */
  app.get('/earned-value/settings', async (request) => {
    if (!anywhere(await guard.permissionsFor(request), 'task:view')) {
      throw EpmError.forbidden('You do not have permission to view work packages.');
    }
    const [settings, catalog] = await Promise.all([getEvmSettings(), getCatalog()]);
    return {
      settings,
      methods: earningMethodsIn(requestLanguage(request)),
      types: [...catalog.typeById.values()].map((type) => ({ id: type.id, name: type.name, isMilestone: type.epm === 'milestone' })),
    };
  });

  /** Saves new rules as a new version (BR-302), journalled. */
  app.put<{ Body: unknown }>('/earned-value/settings', async (request) => {
    await guard.require(request, 'evm:configure');
    return saveEvmSettings(request.body, request.auth!.userId);
  });

  /** A project's baselines, newest first. */
  app.get<{ Params: { id: string } }>('/projects/:id/baselines', async (request) => {
    const id = numeric(request.params.id, message('Project {id}', { id: request.params.id }));
    await guard.require(request, 'task:view', id);
    return listBaselines(Number(id));
  });

  /** Sets a baseline: the project's plan now, priced and frozen (BR-301). */
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>('/projects/:id/baselines', async (request, reply) => {
    const id = numeric(request.params.id, message('Project {id}', { id: request.params.id }));
    await guard.require(request, 'project:edit', id);
    const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim().slice(0, 500) : null;
    const baseline = await setBaseline(Number(id), reason, request.auth!.userId);
    reply.code(201);
    return baseline;
  });

  /**
   * A scope's earned value as at a moment (BR-303): the work as it stood then,
   * rebuilt from the journals, with the rules and the baseline in force then.
   * Without `asAt`, now.
   */
  app.get('/earned-value', async (request) => {
    const query = z
      .object({
        scope: z.string().regex(/^(instance|portfolio:[\w-]+|project:\d+)$/, msg('scope is the instance, a portfolio or a project.')).optional(),
        asAt: z.string().datetime({ offset: true }).optional(),
      })
      .parse(request.query);
    const viewer = await viewerOf(request);
    const scope = await scopeOf(query.scope, viewer);
    const now = new Date();
    const instant = query.asAt ? new Date(query.asAt) : now;
    if (instant.getTime() > now.getTime()) throw EpmError.badRequest('asAt cannot be in the future.');
    const at = instant.toISOString().slice(0, 10);

    const facts = await modelFacts();
    const [evm, resources] = await Promise.all([loadEvmShared(facts), loadResourceShared()]);
    const shared: Shared = {
      facts,
      viewer,
      health: new Map(),
      risk: { typeIds: new Set(), highPriorityIds: new Set(), configured: false },
      evm,
      resources,
    };
    const context = contextFor(shared, scope, { from: at, to: at }, at);
    const work = query.asAt ? (await workFactsAsAt(instant, facts)).filter(context.inScope) : context.work;
    const result = evaluateProjects(evm, {
      projectIds: context.projects.map((project) => project.id),
      at,
      instant,
      work,
      time: context.time,
    });
    return {
      scope,
      at,
      asAt: instant.toISOString(),
      asOf: facts.asOf,
      settingsVersion: result.settingsVersion,
      totals: result.totals,
      projects: result.projects.map((project) => ids(project, scope.kind === 'project')),
    };
  });

  /** One work package's earned value today, as its project's plan has it. */
  app.get<{ Params: { id: string } }>('/work-packages/:id/earned-value', async (request) => {
    const id = numeric(request.params.id, message('Work package {id}', { id: request.params.id }));
    const projectId = await guard.projectOfWorkPackage(request, id);
    await guard.require(request, 'task:view', projectId);
    const language = requestLanguage(request);
    const at = todayIso();
    const facts = await modelFacts();
    if (!facts.projects.has(Number(projectId))) {
      return {
        workPackageId: id,
        projectId,
        at,
        asOf: facts.asOf,
        item: null,
        note: t(language, 'The analytics model has not loaded this project yet.'),
      };
    }
    const evm = await loadEvmShared(facts);
    const work = facts.workPackages.filter((item) => item.projectId === Number(projectId));
    const result = evaluateProjects(evm, {
      projectIds: [Number(projectId)],
      at,
      work,
      time: facts.time.filter((entry) => entry.projectId === Number(projectId)),
    });
    const project = result.projects[0]!;
    const item = project.evaluation.items.find((entry) => entry.workPackageId === Number(id));
    const typeId = work.find((entry) => entry.id === Number(id))?.typeId;
    const settings = await getEvmSettings();
    return {
      workPackageId: id,
      projectId,
      at,
      asOf: facts.asOf,
      measuredAgainst: project.measuredAgainst,
      method: item?.method ?? (typeId !== undefined ? methodOf(settings)(typeId) : settings.defaultMethod),
      item: item ? { ...item, workPackageId: id, projectId } : null,
      note: item
        ? item.bac === null
          ? t(language, 'It has hours but no rate to price them, so it is left out of the figures.')
          : undefined
        : project.measuredAgainst.kind === 'baseline'
          ? t(language, 'It is not in baseline {number}: it earns nothing until a new baseline includes it.', {
              number: project.measuredAgainst.number,
            })
          : t(language, 'The analytics model has not loaded it yet.'),
    };
  });
};
