import type { FastifyPluginAsync } from 'fastify';

import * as guard from '../auth/guard.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { openProject } from '../openproject/client.js';

/**
 * OpenProject Form endpoints, proxied.
 *
 * A Form is OpenProject describing one of its own resources: which fields
 * exist, which are writable, what values each permits, and what is currently
 * invalid. It is the only way to render every field an instance defines —
 * including custom fields, which appear here as ordinary schema entries and so
 * need no code of their own.
 *
 * Posting a partial payload returns the same schema with `validationErrors`
 * populated, which is how the UI validates without restating OpenProject's
 * rules. Nothing is written until the caller posts to the real collection.
 */

interface OpFormResponse {
  _type: string;
  _embedded: {
    payload: Record<string, unknown>;
    schema: Record<string, unknown>;
    validationErrors?: Record<string, { message?: string }>;
  };
  _links?: { commit?: { href: string; method?: string } };
}

export interface FormResult {
  /** Field definitions, keyed by attribute. Custom fields included. */
  schema: Record<string, unknown>;
  /** The payload OpenProject would write, after its own defaulting. */
  payload: Record<string, unknown>;
  /** Attribute -> message. Empty when the payload is valid. */
  errors: Record<string, string>;
  /** Absent when the caller may not commit (no permission, or still invalid). */
  commit?: { href: string; method: string };
}

function toFormResult(form: OpFormResponse): FormResult {
  const errors: Record<string, string> = {};
  for (const [field, detail] of Object.entries(form._embedded.validationErrors ?? {})) {
    errors[field] = detail?.message ?? 'Invalid value.';
  }

  return {
    schema: form._embedded.schema,
    payload: form._embedded.payload,
    errors,
    commit: form._links?.commit
      ? { href: form._links.commit.href, method: (form._links.commit.method ?? 'post').toUpperCase() }
      : undefined,
  };
}

async function requestForm(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<FormResult> {
  const form = await openProject.request<OpFormResponse>(path, {
    method: 'POST',
    body: body ?? {},
    signal,
  });
  return toFormResult(form);
}

export const formRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Schema for creating a work package in a project.
   *
   * Types differ per project and the schema differs per type, so both are
   * required before the form means anything.
   */
  app.post<{ Body: { projectId?: string; typeId?: string; payload?: Record<string, unknown> } }>(
    '/forms/work-packages',
    async (request) => {
      const { projectId, typeId, payload } = request.body ?? {};
      if (!projectId) throw EpmError.badRequest('projectId is required.');

      // A create form describes an action; do not hand it to someone who
      // cannot perform it.
      await guard.require(request, 'task:create', projectId);

      // The type is chosen before the schema loads, because it decides which
      // fields exist. Taken as an id and linked here, so the client never has
      // to build an upstream URL — the rest of the payload is schema values
      // the server itself supplied.
      const body = { ...(payload ?? {}) };
      if (typeId) {
        if (!/^\d+$/.test(typeId)) throw EpmError.badRequest('That type is not valid.');
        body._links = { ...(body._links as object), type: { href: `/api/v3/types/${typeId}` } };
      }

      return requestForm(`/projects/${projectId}/work_packages/form`, body, requestSignal(request));
    },
  );

  /**
   * Schema for editing an existing work package.
   *
   * `lockVersion` is read here rather than taken from the caller so a stale
   * client cannot silently overwrite a newer edit — OpenProject rejects the
   * commit if the version moved on.
   */
  app.post<{ Params: { id: string }; Body: { payload?: Record<string, unknown> } }>(
    '/forms/work-packages/:id',
    async (request) => {
      const { id } = request.params;

      await guard.require(request, 'task:edit', await guard.projectOfWorkPackage(request, id));

      const current = await openProject
        .request<{ lockVersion: number }>(`/work_packages/${id}`, { signal: requestSignal(request) })
        .catch(() => null);
      if (!current) throw EpmError.notFound(`Work package ${id}`);

      return requestForm(
        `/work_packages/${id}/form`,
        { lockVersion: current.lockVersion, ...(request.body?.payload ?? {}) },
        requestSignal(request),
      );
    },
  );

  /** Schema for creating a project — including every custom project field. */
  app.post<{ Body: { payload?: Record<string, unknown> } }>('/forms/projects', async (request) => {
    await guard.require(request, 'project:create');
    return requestForm('/projects/form', request.body?.payload ?? {}, requestSignal(request));
  });

  /** Schema for editing a project. */
  app.post<{ Params: { id: string }; Body: { payload?: Record<string, unknown> } }>(
    '/forms/projects/:id',
    async (request) => {
      await guard.require(request, 'project:edit', request.params.id);
      return requestForm(
        `/projects/${request.params.id}/form`,
        request.body?.payload ?? {},
        requestSignal(request),
      );
    },
  );

  /** Schema for adding or editing a project membership. */
  app.post<{ Body: { projectId?: string; payload?: Record<string, unknown> } }>(
    '/forms/memberships',
    async (request) => {
      // Membership management is per project, so one is required to authorise it.
      const projectId = request.body?.projectId;
      if (!projectId) throw EpmError.badRequest('projectId is required.');

      await guard.require(request, 'member:manage', projectId);
      return requestForm('/memberships/form', request.body?.payload ?? {}, requestSignal(request));
    },
  );

  /**
   * Schema for logging time, with the activities this project allows.
   *
   * Not guarded here. Time entries have no action in the capabilities
   * vocabulary, so a check in EPM would be a guess — and refusing outright,
   * which is what this did, is a guess too. OpenProject applies `log_time` per
   * project on this very endpoint and answers 403 with its own reason, so the
   * form is asked and the refusal is passed on. Same reasoning as the time
   * entry routes themselves; see `routes/time-entries.ts`.
   *
   * A work package implies its project. Either is enough to shape the form,
   * and with neither OpenProject returns the unscoped schema, which is what a
   * blank timesheet row wants.
   */
  app.post<{
    Body: { projectId?: string; workPackageId?: string; payload?: Record<string, unknown> };
  }>('/forms/time-entries', async (request) => {
    const { projectId, workPackageId } = request.body ?? {};

    const links: Record<string, { href: string }> = {};
    if (projectId) {
      if (!/^\d+$/.test(projectId)) throw EpmError.badRequest('That project is not valid.');
      links.project = { href: `/api/v3/projects/${projectId}` };
    }
    if (workPackageId) {
      if (!/^\d+$/.test(workPackageId)) {
        throw EpmError.badRequest('That work package is not valid.');
      }
      links.workPackage = { href: `/api/v3/work_packages/${workPackageId}` };
    }

    const payload = {
      ...(request.body?.payload ?? {}),
      ...(Object.keys(links).length > 0
        ? { _links: { ...links, ...(request.body?.payload?._links as object) } }
        : {}),
    };

    return requestForm('/time_entries/form', payload, requestSignal(request)).catch((error) => {
      if (error instanceof OpenProjectError && error.upstreamStatus === 403) {
        throw EpmError.forbidden(error.message);
      }
      throw error;
    });
  });
};
