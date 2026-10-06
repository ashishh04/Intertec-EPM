import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import * as guard from '../auth/guard.js';
import { env } from '../config/env.js';
import { automationStatus } from '../domain/automation-account.js';
import {
  createPolicy,
  deletePolicy,
  dryRunPolicy,
  lastEscalationSweep,
  listEscalations,
  listPolicies,
  updatePolicy,
} from '../domain/escalation.js';
import { instanceOptions } from '../domain/instance-options.js';
import { lastWebhookReceived, ruleEventStats } from '../domain/rule-events.js';
import { createRule, deleteRule, dryRunRule, getRule, listFirings, listRules, updateRule } from '../domain/rules.js';
import type { AutomationOptions, AutomationStatus } from '../types/epm.js';

/**
 * Rules and escalation (BRQ-10).
 *
 * Everything here is policy that acts across projects — what rules do as the
 * automation account, and who is chased about what — so all of it, reading
 * included, needs `rules:configure`. People see the effects as notifications
 * and in the journal, not here.
 */
export const automationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request) => {
    await guard.require(request, 'rules:configure');
  });

  app.get('/automation/status', async (): Promise<AutomationStatus> => {
    const [account, stats] = await Promise.all([automationStatus(), ruleEventStats()]);
    return {
      account,
      worker: { enabled: env.EPM_RULES_ENABLED, pollSeconds: env.EPM_RULES_POLL_SECONDS, ...stats },
      escalation: {
        enabled: env.EPM_ESCALATION_SWEEP_ENABLED,
        intervalMinutes: env.EPM_ESCALATION_SWEEP_INTERVAL_MINUTES,
        lastRunAt: lastEscalationSweep(),
      },
      webhook: { secretConfigured: Boolean(env.OPENPROJECT_WEBHOOK_SECRET), lastReceivedAt: lastWebhookReceived() },
      outbound: { signing: Boolean(env.EPM_RULES_WEBHOOK_SECRET), allowlist: env.EPM_RULES_OUTBOUND_ALLOWLIST },
    };
  });

  app.get('/automation/options', async (): Promise<AutomationOptions> => instanceOptions());

  /* --------------------------------------------------------------- rules */

  app.get('/automation/rules', async () => listRules());

  app.post<{ Body: unknown }>('/automation/rules', async (request, reply) => {
    reply.code(201);
    return createRule(request.body ?? {}, request.auth!.userId);
  });

  app.get<{ Params: { id: string } }>('/automation/rules/:id', async (request) => getRule(request.params.id));

  app.patch<{ Params: { id: string }; Body: unknown }>('/automation/rules/:id', async (request) =>
    updateRule(request.params.id, request.body ?? {}, request.auth!.userId),
  );

  app.delete<{ Params: { id: string } }>('/automation/rules/:id', async (request, reply) => {
    await deleteRule(request.params.id, request.auth!.userId);
    reply.code(204);
  });

  /** What a rule, saved or not, would have done over a past window. Changes nothing. */
  app.post<{ Body: { rule?: unknown; windowDays?: unknown } }>('/automation/rules/dry-run', async (request) => {
    const body = z.object({ rule: z.unknown(), windowDays: z.coerce.number().optional() }).parse(request.body ?? {});
    return dryRunRule(body.rule ?? {}, body.windowDays ?? 7);
  });

  app.get<{ Querystring: { ruleId?: string; subjectType?: string; subjectId?: string; limit?: string } }>(
    '/automation/firings',
    async (request) => {
      const query = z
        .object({
          ruleId: z.string().optional(),
          subjectType: z.enum(['work_package', 'project']).optional(),
          subjectId: z.string().optional(),
          limit: z.coerce.number().int().optional(),
        })
        .parse(request.query);
      return listFirings(query);
    },
  );

  /* ---------------------------------------------------------- escalation */

  app.get('/automation/escalation-policies', async () => listPolicies());

  app.post<{ Body: unknown }>('/automation/escalation-policies', async (request, reply) => {
    reply.code(201);
    return createPolicy(request.body ?? {}, request.auth!.userId);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/automation/escalation-policies/:id', async (request) =>
    updatePolicy(request.params.id, request.body ?? {}, request.auth!.userId),
  );

  app.delete<{ Params: { id: string } }>('/automation/escalation-policies/:id', async (request, reply) => {
    await deletePolicy(request.params.id, request.auth!.userId);
    reply.code(204);
  });

  /** What a policy, saved or not, would raise now. Raises and sends nothing. */
  app.post<{ Body: { policy?: unknown } }>('/automation/escalation-policies/dry-run', async (request) =>
    dryRunPolicy(request.body?.policy ?? {}),
  );

  app.get<{ Querystring: { state?: string; policyId?: string; subjectType?: string; subjectId?: string; limit?: string } }>(
    '/automation/escalations',
    async (request) => {
      const query = z
        .object({
          state: z.enum(['open', 'resolved', 'all']).optional(),
          policyId: z.string().optional(),
          subjectType: z.string().optional(),
          subjectId: z.string().optional(),
          limit: z.coerce.number().int().optional(),
        })
        .parse(request.query);
      return listEscalations(query);
    },
  );
};
