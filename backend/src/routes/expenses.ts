import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { allows } from '../auth/capabilities.js';
import * as guard from '../auth/guard.js';
import {
  RECEIPT_MAX_BYTES,
  addReceipt,
  claimView,
  createCategory,
  createClaim,
  deleteClaim,
  deleteReceipt,
  exportClaims,
  listCategories,
  listClaims,
  postClaim,
  receiptContent,
  submitClaim,
  updateClaim,
  withdrawClaim,
  type ExpenseViewer,
} from '../domain/expenses-store.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { contentDispositionFor } from '../lib/uploads.js';

/**
 * Expense claims (Module 10: BR-307 to BR-309).
 *
 * Anyone may claim a cost on a project they are a member of, and read their
 * own claims; the approvers a claim's chain names read it while it is theirs to
 * decide; whoever holds `expenses:manage` reads every claim and its receipts,
 * posts an approved claim again if posting failed, and exports a period for
 * finance. Categories are OpenProject's cost types: anyone reads them, and
 * `time:configure` or `expenses:manage` adds one.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function viewerOf(request: FastifyRequest): Promise<ExpenseViewer> {
  return { id: request.auth!.userId, manage: allows(await guard.permissionsFor(request), 'expenses:manage') };
}

export const expenseRoutes: FastifyPluginAsync = async (app) => {
  /* ----------------------------------------------------------- categories */

  app.get('/expenses/categories', async () => listCategories());

  app.post<{ Body: unknown }>('/expenses/categories', async (request, reply) => {
    const permissions = await guard.permissionsFor(request);
    if (!allows(permissions, 'time:configure') && !allows(permissions, 'expenses:manage')) {
      throw EpmError.forbidden('Adding a category needs the time and expense rules or the expense claims permission.');
    }
    reply.code(201);
    return createCategory(request.body, request.auth!.userId);
  });

  /* --------------------------------------------------------------- claims */

  app.get('/expenses', async (request) => {
    const query = z
      .object({
        scope: z.enum(['mine', 'all']).optional(),
        status: z.enum(['draft', 'submitted', 'approved', 'posted']).optional(),
        projectId: z.string().regex(/^\d+$/).optional(),
        from: z.string().regex(DAY).optional(),
        to: z.string().regex(DAY).optional(),
      })
      .parse(request.query);
    return listClaims({ ...query, scope: query.scope ?? 'mine' }, await viewerOf(request));
  });

  /** The finance export (BR-309): approved claims spent in a period, as a workbook. */
  app.get('/expenses/export', async (request, reply) => {
    const query = z.object({ from: z.string().regex(DAY), to: z.string().regex(DAY) }).parse(request.query);
    if (query.to < query.from) throw EpmError.validation('The period ends before it starts.');
    const bytes = await exportClaims(query.from, query.to, await viewerOf(request));
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', contentDispositionFor(`expense-claims-${query.from}-to-${query.to}.xlsx`))
      .header('Cache-Control', 'private, no-store');
    return reply.send(Buffer.from(bytes));
  });

  app.post<{ Body: { projectId?: unknown } }>('/expenses', async (request, reply) => {
    const projectId = typeof request.body?.projectId === 'string' ? request.body.projectId : '';
    if (!/^\d+$/.test(projectId)) throw EpmError.validation('Choose the project.');
    // Someone who cannot see the project learns nothing about it here.
    await guard.require(request, 'project:view', projectId);
    reply.code(201);
    return createClaim(request.body, request.auth!.userId);
  });

  app.get<{ Params: { id: string } }>('/expenses/:id', async (request) => claimView(request.params.id, await viewerOf(request)));

  app.patch<{ Params: { id: string }; Body: { projectId?: unknown } }>('/expenses/:id', async (request) => {
    const projectId = typeof request.body?.projectId === 'string' ? request.body.projectId : '';
    if (/^\d+$/.test(projectId)) await guard.require(request, 'project:view', projectId);
    return updateClaim(request.params.id, request.body, request.auth!.userId);
  });

  app.delete<{ Params: { id: string } }>('/expenses/:id', async (request, reply) => {
    await deleteClaim(request.params.id, request.auth!.userId);
    reply.code(204);
  });

  app.post<{ Params: { id: string } }>('/expenses/:id/submit', async (request) => submitClaim(request.params.id, request.auth!.userId));

  app.post<{ Params: { id: string } }>('/expenses/:id/withdraw', async (request) =>
    withdrawClaim(request.params.id, await viewerOf(request)),
  );

  /** Posts an approved claim whose posting failed (BR-309). */
  app.post<{ Params: { id: string } }>('/expenses/:id/post', async (request) => {
    await guard.require(request, 'expenses:manage');
    return postClaim(request.params.id, request.auth!.userId);
  });

  /* ------------------------------------------------------------- receipts */

  app.post<{ Params: { id: string } }>('/expenses/:id/receipts', async (request, reply) => {
    const uploaded = await request.file({ limits: { fileSize: RECEIPT_MAX_BYTES, files: 1 } }).catch(() => {
      throw EpmError.badRequest('Send the receipt as multipart/form-data.');
    });
    if (!uploaded) throw EpmError.badRequest('No file was uploaded.');
    const content = await uploaded.toBuffer();
    if (uploaded.file.truncated) {
      throw EpmError.validation(message('A receipt is at most {limit} MB.', { limit: RECEIPT_MAX_BYTES / 1024 / 1024 }));
    }
    const fileName = uploaded.filename?.trim();
    if (!fileName) throw EpmError.badRequest('The file has no name.');
    reply.code(201);
    return addReceipt(request.params.id, { fileName, contentType: uploaded.mimetype, content }, request.auth!.userId);
  });

  app.get<{ Params: { id: string; receiptId: string } }>('/expenses/:id/receipts/:receiptId', async (request, reply) => {
    const receipt = await receiptContent(request.params.id, request.params.receiptId, await viewerOf(request));
    reply
      .header('Content-Type', receipt.contentType)
      .header('Content-Disposition', contentDispositionFor(receipt.fileName))
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(Buffer.from(receipt.content));
  });

  app.delete<{ Params: { id: string; receiptId: string } }>('/expenses/:id/receipts/:receiptId', async (request, reply) => {
    await deleteReceipt(request.params.id, request.params.receiptId, request.auth!.userId);
    reply.code(204);
  });
};
