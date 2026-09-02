import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject } from '../openproject/client.js';

/**
 * Full-fidelity work package writes.
 *
 * `/tasks` writes the normalized EPM model, which is deliberately narrow: it
 * covers the fields the curated screens expose and nothing else. These routes
 * take an OpenProject payload verbatim instead, so a form rendered from an
 * OpenProject schema can commit every field the instance defines — custom
 * fields included — without the EPM contract having to grow a column for each.
 *
 * Both paths coexist on purpose. The normalized one keeps the product's own
 * screens simple; this one exists so nothing is unreachable.
 */

interface OpWorkPackageWrite {
  id: number;
  subject: string;
  lockVersion: number;
  _links?: Record<string, { href?: string; title?: string }>;
}

export const workPackageRoutes: FastifyPluginAsync = async (app) => {
  /** Create from a raw OpenProject payload. */
  app.post<{ Body: { projectId?: string; payload?: Record<string, unknown> } }>(
    '/work-packages',
    async (request, reply) => {
      const { projectId, payload } = request.body ?? {};
      if (!projectId) throw EpmError.badRequest('projectId is required.');
      if (!payload || typeof payload !== 'object') {
        throw EpmError.badRequest('payload is required.');
      }

      await guard.require(request, 'task:create', projectId);

      const created = await openProject.request<OpWorkPackageWrite>(
        `/projects/${projectId}/work_packages`,
        {
          method: 'POST',
          body: payload,
          // These projects have real people on them; creating work should not
          // email everyone watching while the UI is being exercised.
          query: { notify: 'false' },
          signal: requestSignal(request),
        },
      );

      reply.code(201);
      return { id: String(created.id), subject: created.subject, lockVersion: created.lockVersion };
    },
  );

  /**
   * Update from a raw OpenProject payload.
   *
   * `lockVersion` is read here rather than trusted from the client. A caller
   * that renders a form, waits, then submits would otherwise overwrite whatever
   * landed in between; re-reading narrows that window to this request, and
   * OpenProject still rejects the write if the version moves under us.
   */
  app.patch<{ Params: { id: string }; Body: { payload?: Record<string, unknown> } }>(
    '/work-packages/:id',
    async (request) => {
      const { id } = request.params;
      const payload = request.body?.payload;
      if (!payload || typeof payload !== 'object') {
        throw EpmError.badRequest('payload is required.');
      }

      // The work package's own project decides this, not the caller.
      await guard.require(request, 'task:edit', await guard.projectOfWorkPackage(request, id));

      const signal = requestSignal(request);
      const current = await openProject
        .request<OpWorkPackageWrite>(`/work_packages/${id}`, { signal })
        .catch(() => null);
      if (!current) throw EpmError.notFound(`Work package ${id}`);

      const updated = await openProject.request<OpWorkPackageWrite>(`/work_packages/${id}`, {
        method: 'PATCH',
        body: { lockVersion: current.lockVersion, ...payload },
        query: { notify: 'false' },
        signal,
      });

      return { id: String(updated.id), subject: updated.subject, lockVersion: updated.lockVersion };
    },
  );

  app.delete<{ Params: { id: string } }>('/work-packages/:id', async (request, reply) => {
    await guard.requireLink(
      request,
      `/work_packages/${request.params.id}`,
      'delete',
      'delete this work package',
    );

    await openProject.request<void>(`/work_packages/${request.params.id}`, {
      method: 'DELETE',
      signal: requestSignal(request),
    });
    reply.code(204);
  });
};
