import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getPolicy, savePolicy, usage } from '../assistant/policy.js';
import { runAsSystem } from '../auth/context.js';
import * as guard from '../auth/guard.js';
import { openProject } from '../openproject/client.js';
import { EVERY_USER } from '../openproject/people.js';
import type { AssistantUsageRow } from '../types/epm.js';

/**
 * Administering Pragnya's guardrails (Module 13): its settings, and who uses
 * it how much — counts and lookups only, never what anyone asked. Needs
 * `users:manage`.
 */
export const assistantAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request) => {
    await guard.require(request, 'users:manage');
  });

  app.get('/admin/assistant-policy', async () => getPolicy());

  app.put<{ Body: unknown }>('/admin/assistant-policy', async (request) => savePolicy(request.body, request.auth!.userId));

  app.get<{ Querystring: { days?: string } }>('/admin/assistant-usage', async (request): Promise<AssistantUsageRow[]> => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(request.query);
    const [rows, users] = await Promise.all([
      usage(days),
      runAsSystem(() => openProject.getAll<{ id: number; name: string }>('/principals', { pageSize: 1000, filters: EVERY_USER })).catch(() => ({ items: [] as { id: number; name: string }[] })),
    ]);
    const names = new Map(users.items.map((user) => [String(user.id), user.name]));
    return rows.map((row) => ({ ...row, userName: names.get(row.userId) ?? `#${row.userId}` }));
  });
};
