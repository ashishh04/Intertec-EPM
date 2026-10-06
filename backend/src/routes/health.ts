import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { prisma } from '../db/prisma.js';
import { listAudit } from '../domain/audit.js';
import { computeHealth, type HealthInputs } from '../domain/health.js';
import {
  getHealthRules,
  parseHealthRules,
  resolveRiskSelection,
  saveHealthRules,
} from '../domain/health-rules.js';
import { requestHealthRecalc } from '../domain/health.js';
import { today } from '../lib/dates.js';
import { requestSignal } from '../lib/request-signal.js';
import type { HealthLevel, HealthRules } from '../types/epm.js';
import { loadProjects } from './projects.js';

/**
 * The health rules (BR-204).
 *
 * Reading them is open to anyone signed in: every project's health is
 * explained in terms of these thresholds, and an explanation that points at
 * rules nobody may read explains nothing. Changing them needs
 * `health:configure`, which is policy for every project and is deliberately
 * not the same permission as overriding one.
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health/rules', async () => getHealthRules());

  /** The types and priorities the editor offers, and what "none chosen" means today. */
  app.get('/health/rules/options', async (request) => {
    await guard.require(request, 'health:configure');
    const rules = await getHealthRules();
    return (await resolveRiskSelection(rules, requestSignal(request))).options;
  });

  /**
   * Saves the rules as a new version and recalculates every project.
   *
   * The recalculation is queued, not awaited: on a large instance it takes a
   * while, and the stored values stay readable throughout — each project moves
   * to the new rules as it is reached.
   */
  app.put<{ Body: unknown }>('/health/rules', async (request) => {
    await guard.require(request, 'health:configure');
    const saved = await saveHealthRules(request.body ?? {}, request.auth!.userId);
    requestHealthRecalc('all', 'rules');
    return saved;
  });

  /**
   * What the given rules would do, without saving them.
   *
   * Recomputed from the inputs stored with each project's last calculation,
   * so it costs no upstream request and changes nothing. The one thing it
   * cannot show is a change to which types count as risks: the stored counts
   * were taken with the current selection, and the response says so.
   */
  app.post<{ Body: unknown }>('/health/rules/preview', async (request) => {
    await guard.require(request, 'health:configure');
    const candidate: HealthRules = { ...parseHealthRules(request.body ?? {}), version: -1 };
    const current = await getHealthRules();

    const visible = await loadProjects(requestSignal(request));
    const names = new Map(visible.map((project) => [project.id, project.name]));
    const states = await prisma.projectHealthState.findMany({
      where: { projectId: { in: [...names.keys()] } },
    });

    const day = today();
    const rows = states.map((state) => {
      const inputs = { ...(state.inputs as unknown as HealthInputs), today: day };
      const levels = (state.levels ?? {}) as { overall?: HealthLevel };
      const now = computeHealth(inputs, current);
      const next = computeHealth(inputs, candidate);
      return {
        projectId: state.projectId,
        projectName: names.get(state.projectId) ?? state.projectId,
        current: now.levels,
        preview: next.levels,
        explanation: next.explanation,
        changed: now.levels.overall !== next.levels.overall,
        stored: levels.overall ?? null,
      };
    });

    const sameRiskSelection =
      candidate.criteria.risks.typeIds.join() === current.criteria.risks.typeIds.join() &&
      candidate.criteria.risks.priorityIds.join() === current.criteria.risks.priorityIds.join();

    return {
      projects: rows.sort((a, b) => Number(b.changed) - Number(a.changed) || a.projectName.localeCompare(b.projectName)),
      changed: rows.filter((row) => row.changed).length,
      note: sameRiskSelection
        ? undefined
        : 'Risk counts are shown with the current risk types and priorities; the new selection applies once saved.',
    };
  });

  /** Every version of the rules, newest first, with who changed what. */
  app.get('/health/rules/history', async () =>
    listAudit({ entityType: 'health-rules', limit: 100 }),
  );
};
