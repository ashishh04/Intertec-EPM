import { Prisma, type ApprovalRequest, type ExpenseClaim, type ExpenseReceipt } from '@prisma/client';
import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { today as todayIso } from '../lib/dates.js';
import { EpmError } from '../lib/errors.js';
import { contextLanguage, dateOf, message, msg, t } from '../lib/i18n.js';
import { buildWorkbook } from '../lib/xlsx.js';
import { listProjects } from '../mapping/projects.js';
import { getUsers } from '../mapping/users.js';
import { linkId, linkTitle, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import type { ExpenseCategory, ExpenseClaimStatus, ExpenseClaimView, ExpenseReceiptView } from '../types/epm.js';
import { cancelRequest, registerSubjectAdapter, requestsFor, submitSubject, type LoadedSubject } from './approvals.js';
import { withAudit } from './audit.js';
import { invalidateProjectCost } from './costs.js';
import { assertKnownCurrency, Converter, rateOn, reportingCurrency } from './currency.js';
import { getTimeSettings } from './time-rules.js';

/**
 * Expense claims (BR-307 to BR-309).
 *
 * A claim is a cost someone paid for a project: a category, an amount, a day,
 * the project and work package it was for, and its receipts — required above
 * the threshold in the time and expense settings. It goes through the approval
 * engine like a work package, its amount the value a chain routes on (a step
 * that applies above a figure adds an approver), and a rejection returns it to
 * draft with the reason.
 *
 * Approved, it becomes what OpenProject already has for such costs: a cost
 * entry of its category (an OpenProject cost type) on the work package, made
 * through EPM's add-on because API v3 cannot (`openproject/zzz_epm_costs.rb`).
 * OpenProject's budgets then count it as spent and its cost reports list it;
 * EPM's cost figures read it from the analytics model; and the finance export
 * lists it for its period. Receipts are kept in EPM's own database.
 */

const date = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);
const money = (value: Prisma.Decimal | number) => Math.round(Number(value) * 100) / 100;

/** At most this much per receipt, and this many receipts per claim. */
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const RECEIPTS_PER_CLAIM = 5;
const RECEIPT_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

export interface ExpenseViewer {
  id: string;
  /** expenses:manage — every claim, its receipts, posting, the finance export. */
  manage: boolean;
}

/** The key a claim goes by in lists and emails. */
export const claimKey = (id: string) => `EX-${id.slice(-6).toUpperCase()}`;

/* -------------------------------------------------------------------------- */
/* Categories: OpenProject cost types                                          */
/* -------------------------------------------------------------------------- */

interface OpCostType {
  id: number;
  name: string;
  unit: string;
  unitPlural: string;
  rate: number | null;
  default: boolean;
}

let categoryCache: { at: number; value: ExpenseCategory[] } | undefined;

export async function listCategories(): Promise<ExpenseCategory[]> {
  if (categoryCache && Date.now() - categoryCache.at < 60_000) return categoryCache.value;
  const { types } = await runAsSystem(() => openProject.request<{ types: OpCostType[] }>('/epm_admin/costs/types', { root: true }));
  // Cost entries are in the reporting currency, which every cost figure is in.
  const currency = reportingCurrency();
  const value = types.map((type) => ({
    id: String(type.id),
    name: type.name,
    unit: type.unit,
    unitPlural: type.unitPlural,
    rate: type.rate,
    // A unit that is the currency, at 1, makes its units the amount itself.
    isAmount: type.unit.trim().toUpperCase() === currency && type.rate === 1,
  }));
  categoryCache = { at: Date.now(), value };
  return value;
}

const categorySchema = z.object({ name: z.string().trim().min(1, 'Name the category.').max(120) });

/** Adds a category: an OpenProject cost type whose unit is the currency, at 1. */
export async function createCategory(input: unknown, actorId: string): Promise<ExpenseCategory> {
  const parsed = categorySchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation(parsed.error.issues[0]?.message ?? 'That category is not valid.');
  const { name } = parsed.data;
  if ((await listCategories()).some((category) => category.name.toLowerCase() === name.toLowerCase())) {
    throw EpmError.conflict(message('There is already a category called {name}.', { name }));
  }
  const currency = reportingCurrency();
  const created = await runAsSystem(() =>
    openProject.request<OpCostType>('/epm_admin/costs/types', {
      root: true,
      method: 'POST',
      body: { name, unit: currency, unitPlural: currency, rate: 1 },
    }),
  );
  categoryCache = undefined;
  await withAudit(async () => created, {
    actorId,
    entityType: 'expense-category',
    entityId: String(created.id),
    action: 'expense.category.created',
    summary: message('Expense category {name} added, in {currency}.', { name, currency }),
    after: { costTypeId: created.id, name, unit: currency },
  });
  return (await listCategories()).find((category) => category.id === String(created.id))!;
}

/* -------------------------------------------------------------------------- */
/* Claims                                                                      */
/* -------------------------------------------------------------------------- */

const claimSchema = z.object({
  projectId: z.string().regex(/^\d+$/, 'Choose the project.'),
  workPackageId: z.string().regex(/^\d+$/, 'Choose the work package the cost was for.'),
  categoryId: z.string().regex(/^\d+$/, 'Choose a category.'),
  amount: z.coerce.number().positive('The amount is more than nothing.').max(1e9),
  /** The currency it was paid in (BR-320); the claims' usual currency when left out. */
  currency: z.string().optional(),
  spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the day the cost was paid.'),
  description: z.string().trim().min(1, 'Say what the cost was for.').max(2000),
});

async function workPackageIn(workPackageId: string, projectId: string): Promise<{ subject: string }> {
  const work = await runAsSystem(() =>
    openProject.request<{ subject: string; _links?: Record<string, HalLink | HalLink[] | undefined> }>(`/work_packages/${workPackageId}`),
  ).catch(() => null);
  if (!work) throw EpmError.validation('That work package does not exist.');
  if (linkId(work._links ?? {}, 'project') !== projectId) throw EpmError.validation('That work package is not in that project.');
  return { subject: work.subject };
}

/** OpenProject records a cost only for a member of the project, so a claim is made by one. */
async function assertMember(personId: string, projectId: string): Promise<void> {
  const members = await runAsSystem(() =>
    openProject.getCollection<unknown>('/memberships', {
      filters: [
        { field: 'project', operator: '=', values: [projectId] },
        { field: 'principal', operator: '=', values: [personId] },
      ],
      pageSize: 1,
    }),
  ).catch(() => null);
  if (!members || (members.total ?? 0) === 0) {
    throw EpmError.validation('You can claim a cost only on a project you are a member of.');
  }
}

async function validClaim(input: unknown, claimantId: string) {
  const parsed = claimSchema.safeParse(input ?? {});
  if (!parsed.success) throw EpmError.validation(parsed.error.issues[0]?.message ?? 'That claim is not complete.');
  const claim = parsed.data;
  if (claim.spentOn > todayIso()) throw EpmError.validation('A claim is for a cost already paid: the day cannot be in the future.');
  const category = (await listCategories()).find((candidate) => candidate.id === claim.categoryId);
  if (!category) throw EpmError.validation('That category does not exist.');
  await workPackageIn(claim.workPackageId, claim.projectId);
  await assertMember(claimantId, claim.projectId);
  const currency = await assertKnownCurrency(claim.currency ?? (await getTimeSettings()).expenses.currency);
  return { claim: { ...claim, currency }, category };
}

export async function createClaim(input: unknown, claimantId: string): Promise<ExpenseClaimView> {
  const { claim, category } = await validClaim(input, claimantId);
  const currency = claim.currency;
  const row = await withAudit(
    (tx) =>
      tx.expenseClaim.create({
        data: {
          claimantId,
          projectId: Number(claim.projectId),
          workPackageId: Number(claim.workPackageId),
          costTypeId: Number(claim.categoryId),
          amount: new Prisma.Decimal(claim.amount.toFixed(2)),
          currency,
          spentOn: date(claim.spentOn),
          description: claim.description,
        },
      }),
    (created) => ({
      actorId: claimantId,
      projectId: claim.projectId,
      entityType: 'expense-claim',
      entityId: created.id,
      action: 'expense.created',
      summary: message('Expense claim {key} drafted: {category}, {amount, number} {currency}.', {
        key: claimKey(created.id),
        category: category.name,
        amount: claim.amount,
        currency,
      }),
      after: { ...claim },
    }),
  );
  return claimView(row.id, { id: claimantId, manage: false });
}

async function draftOf(id: string, actorId: string): Promise<ExpenseClaim> {
  const row = await prisma.expenseClaim.findUnique({ where: { id } });
  if (!row) throw EpmError.notFound('That claim');
  if (row.claimantId !== actorId) throw EpmError.forbidden('Only the person who made a claim can change it.');
  if (row.status !== 'draft') throw EpmError.conflict('Only a draft claim can be changed: withdraw it first.');
  return row;
}

export async function updateClaim(id: string, input: unknown, actorId: string): Promise<ExpenseClaimView> {
  const before = await draftOf(id, actorId);
  const { claim } = await validClaim(input, actorId);
  await withAudit(
    (tx) =>
      tx.expenseClaim.update({
        where: { id },
        data: {
          projectId: Number(claim.projectId),
          workPackageId: Number(claim.workPackageId),
          costTypeId: Number(claim.categoryId),
          amount: new Prisma.Decimal(claim.amount.toFixed(2)),
          currency: claim.currency,
          spentOn: date(claim.spentOn),
          description: claim.description,
        },
      }),
    {
      actorId,
      projectId: claim.projectId,
      entityType: 'expense-claim',
      entityId: id,
      action: 'expense.updated',
      summary: message('Expense claim {key} changed.', { key: claimKey(id) }),
      before: { amount: money(before.amount), spentOn: iso(before.spentOn), costTypeId: before.costTypeId, workPackageId: before.workPackageId },
      after: { ...claim },
    },
  );
  return claimView(id, { id: actorId, manage: false });
}

export async function deleteClaim(id: string, actorId: string): Promise<void> {
  const row = await draftOf(id, actorId);
  await withAudit((tx) => tx.expenseClaim.delete({ where: { id } }), {
    actorId,
    projectId: String(row.projectId),
    entityType: 'expense-claim',
    entityId: id,
    action: 'expense.deleted',
    summary: message('Expense claim {key} deleted as a draft.', { key: claimKey(id) }),
    before: { amount: money(row.amount), spentOn: iso(row.spentOn) },
  });
}

/* -------------------------------------------------------------------------- */
/* Receipts                                                                    */
/* -------------------------------------------------------------------------- */

const receiptView = (row: Pick<ExpenseReceipt, 'id' | 'fileName' | 'contentType' | 'size' | 'createdAt'>): ExpenseReceiptView => ({
  id: row.id,
  fileName: row.fileName,
  contentType: row.contentType,
  size: row.size,
  uploadedAt: row.createdAt.toISOString(),
});

export async function addReceipt(
  claimId: string,
  file: { fileName: string; contentType: string; content: Buffer },
  actorId: string,
): Promise<ExpenseReceiptView> {
  const claim = await draftOf(claimId, actorId);
  if (!RECEIPT_TYPES.has(file.contentType)) throw EpmError.validation('A receipt is a PDF or a picture: PDF, PNG, JPEG, WebP, GIF or HEIC.');
  if (file.content.length > RECEIPT_MAX_BYTES) {
    throw EpmError.validation(message('A receipt is at most {limit} MB.', { limit: RECEIPT_MAX_BYTES / 1024 / 1024 }));
  }
  if ((await prisma.expenseReceipt.count({ where: { claimId } })) >= RECEIPTS_PER_CLAIM) {
    throw EpmError.validation(message('A claim has at most {count} receipts.', { count: RECEIPTS_PER_CLAIM }));
  }
  const row = await withAudit(
    (tx) =>
      tx.expenseReceipt.create({
        data: {
          claimId,
          fileName: file.fileName.slice(0, 255),
          contentType: file.contentType,
          size: file.content.length,
          content: new Uint8Array(file.content),
          uploadedBy: actorId,
        },
        select: { id: true, fileName: true, contentType: true, size: true, createdAt: true },
      }),
    (created) => ({
      actorId,
      projectId: String(claim.projectId),
      entityType: 'expense-claim',
      entityId: claimId,
      action: 'expense.receipt.added',
      summary: message('Receipt {file} added to expense claim {key}.', { file: created.fileName, key: claimKey(claimId) }),
      after: { receiptId: created.id, size: created.size, contentType: created.contentType },
    }),
  );
  return receiptView(row);
}

export async function deleteReceipt(claimId: string, receiptId: string, actorId: string): Promise<void> {
  const claim = await draftOf(claimId, actorId);
  const receipt = await prisma.expenseReceipt.findFirst({ where: { id: receiptId, claimId }, select: { id: true, fileName: true } });
  if (!receipt) throw EpmError.notFound('That receipt');
  await withAudit((tx) => tx.expenseReceipt.delete({ where: { id: receiptId } }), {
    actorId,
    projectId: String(claim.projectId),
    entityType: 'expense-claim',
    entityId: claimId,
    action: 'expense.receipt.removed',
    summary: message('Receipt {file} removed from expense claim {key}.', { file: receipt.fileName, key: claimKey(claimId) }),
  });
}

/** Whether the viewer is someone a claim's approval asked. */
async function asked(claim: ExpenseClaim, viewerId: string): Promise<boolean> {
  if (!claim.requestId) return false;
  const requestIds = (await prisma.approvalRequest.findMany({ where: { subjectType: 'expense_claim', subjectId: claim.id }, select: { id: true } })).map(
    (row) => row.id,
  );
  return (
    (await prisma.approvalTask.count({
      where: { requestId: { in: requestIds }, OR: [{ approverId: viewerId }, { delegateId: viewerId }] },
    })) > 0
  );
}

async function assertMayRead(claim: ExpenseClaim, viewer: ExpenseViewer): Promise<void> {
  if (claim.claimantId === viewer.id || viewer.manage || (await asked(claim, viewer.id))) return;
  throw EpmError.notFound('That claim');
}

export async function receiptContent(claimId: string, receiptId: string, viewer: ExpenseViewer): Promise<ExpenseReceipt> {
  const claim = await prisma.expenseClaim.findUnique({ where: { id: claimId } });
  if (!claim) throw EpmError.notFound('That claim');
  await assertMayRead(claim, viewer);
  const receipt = await prisma.expenseReceipt.findFirst({ where: { id: receiptId, claimId } });
  if (!receipt) throw EpmError.notFound('That receipt');
  return receipt;
}

/* -------------------------------------------------------------------------- */
/* Submitting and its outcomes                                                 */
/* -------------------------------------------------------------------------- */

/** Submits a draft claim (BR-307): one above the receipt threshold needs a receipt first. */
export async function submitClaim(id: string, actorId: string): Promise<ExpenseClaimView> {
  const claim = await draftOf(id, actorId);
  const settings = await getTimeSettings();
  await rateOn(claim.currency, iso(claim.spentOn));
  const receipts = await prisma.expenseReceipt.count({ where: { claimId: id } });
  if (money(claim.amount) > settings.expenses.receiptThreshold && receipts === 0) {
    throw EpmError.validation(
      message('A claim over {threshold, number} {currency} needs a receipt: attach one before submitting it.', {
        threshold: settings.expenses.receiptThreshold,
        currency: claim.currency,
      }),
    );
  }
  const requestId = await submitSubject('expense_claim', id, actorId);
  await withAudit(
    (tx) =>
      tx.expenseClaim.update({
        where: { id },
        data: { status: 'submitted', submittedAt: new Date(), requestId, rejectedAt: null, rejectedBy: null, rejectionReason: null },
      }),
    {
      actorId,
      projectId: String(claim.projectId),
      entityType: 'expense-claim',
      entityId: id,
      action: 'expense.submitted',
      summary: message('Expense claim {key} submitted for {amount, number} {currency}.', {
        key: claimKey(id),
        amount: money(claim.amount),
        currency: claim.currency,
      }),
      after: { requestId, receipts },
    },
  );
  return claimView(id, { id: actorId, manage: false });
}

export async function withdrawClaim(id: string, viewer: ExpenseViewer): Promise<ExpenseClaimView> {
  const claim = await prisma.expenseClaim.findUnique({ where: { id } });
  if (!claim) throw EpmError.notFound('That claim');
  if (claim.claimantId !== viewer.id && !viewer.manage) throw EpmError.forbidden('Only the person who made a claim can withdraw it.');
  if (claim.status !== 'submitted' || !claim.requestId) throw EpmError.conflict('Only a submitted claim can be withdrawn.');
  await cancelRequest({ requestId: claim.requestId, actorId: viewer.id, mayCancelAny: viewer.manage });
  return claimView(id, viewer);
}

interface OpCostEntry {
  id: number;
  costs: number | null;
}

/**
 * Posts an approved claim as an OpenProject cost entry (BR-309): its category's
 * units, with the amount itself kept as the cost. Recorded on the claim either
 * way; one that fails stays approved and can be posted again.
 */
export async function postClaim(id: string, actorId: string | null): Promise<ExpenseClaimView | undefined> {
  const claim = await prisma.expenseClaim.findUnique({ where: { id } });
  if (!claim) throw EpmError.notFound('That claim');
  if (claim.status !== 'approved') throw EpmError.conflict('Only an approved claim that is not yet posted can be posted.');
  // The cost entry is in the reporting currency, at the rate for the day it was paid (BR-321);
  // the claim keeps its own currency and amount (BR-320).
  const reporting = reportingCurrency();
  let converted: { amount: number; rate: number };
  try {
    converted = await new Converter().on(money(claim.amount), claim.currency, reporting, iso(claim.spentOn));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await prisma.expenseClaim.update({ where: { id }, data: { postError: reason.slice(0, 1000) } });
    return actorId ? claimView(id, { id: actorId, manage: true }) : undefined;
  }
  const amount = converted.amount;
  const category = (await listCategories().catch(() => [])).find((candidate) => candidate.id === String(claim.costTypeId));
  const units = category && !category.isAmount && category.rate ? Math.round((amount / category.rate) * 10_000) / 10_000 : amount;
  try {
    const entry = await runAsSystem(() =>
      openProject.request<OpCostEntry>('/epm_admin/costs/entries', {
        root: true,
        method: 'POST',
        body: {
          workPackageId: claim.workPackageId,
          userId: Number(claim.claimantId),
          costTypeId: claim.costTypeId,
          units,
          spentOn: iso(claim.spentOn),
          comments: `${claimKey(id)}: ${claim.description}`.slice(0, 255),
          overriddenCosts: amount,
        },
      }),
    );
    await withAudit(
      (tx) =>
        tx.expenseClaim.update({
          where: { id },
          data: {
            status: 'posted',
            costEntryId: entry.id,
            postedAt: new Date(),
            postError: null,
            reportingCurrency: reporting,
            reportingAmount: new Prisma.Decimal(amount.toFixed(2)),
            exchangeRate: new Prisma.Decimal(converted.rate.toFixed(8)),
            rateDate: claim.spentOn,
          },
        }),
      {
        actorId,
        projectId: String(claim.projectId),
        entityType: 'expense-claim',
        entityId: id,
        action: 'expense.posted',
        summary: message('Expense claim {key} posted to the project as OpenProject cost entry {entry}.', { key: claimKey(id), entry: entry.id }),
        after: { costEntryId: entry.id, amount, units, currency: claim.currency, claimed: money(claim.amount), rate: converted.rate },
      },
    );
    invalidateProjectCost(String(claim.projectId));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await withAudit((tx) => tx.expenseClaim.update({ where: { id }, data: { postError: reason.slice(0, 1000) } }), {
      actorId,
      projectId: String(claim.projectId),
      entityType: 'expense-claim',
      entityId: id,
      action: 'expense.post.failed',
      summary: message('Expense claim {key} could not be posted: {reason}', { key: claimKey(id), reason }),
    });
  }
  return actorId ? claimView(id, { id: actorId, manage: true }) : undefined;
}

async function loadClaim(id: string): Promise<LoadedSubject> {
  const claim = await prisma.expenseClaim.findUnique({ where: { id } });
  if (!claim) throw EpmError.notFound('That claim');
  const [projects, categories, profile] = await Promise.all([
    runAsSystem(() => listProjects()).catch(() => []),
    listCategories().catch(() => []),
    prisma.projectProfile.findUnique({ where: { openProjectId: String(claim.projectId) }, select: { portfolioId: true } }),
  ]);
  const projectId = String(claim.projectId);
  const category = categories.find((candidate) => candidate.id === String(claim.costTypeId))?.name ?? `#${claim.costTypeId}`;
  return {
    id,
    key: claimKey(id),
    title: `${category}, ${money(claim.amount).toFixed(2)} ${claim.currency}: ${claim.description}`.slice(0, 200),
    projectId,
    projectName: projects.find((project) => String(project.id) === projectId)?.name ?? '',
    facts: { projectId, portfolioId: profile?.portfolioId ?? undefined, customFields: {} },
    value: (await new Converter().on(money(claim.amount), claim.currency, reportingCurrency(), iso(claim.spentOn)).catch(() => ({ amount: money(claim.amount) }))).amount,
    valueLabel: msg('Amount'),
  };
}

async function onOutcome(
  outcome: 'approved' | 'rejected' | 'withdrawn',
  request: ApprovalRequest,
  detail: { actorId: string | null; comment?: string },
): Promise<void> {
  const claim = await prisma.expenseClaim.findUnique({ where: { id: request.subjectId } });
  if (!claim || claim.requestId !== request.id || claim.status !== 'submitted') return;
  const audit = { projectId: String(claim.projectId), entityType: 'expense-claim', entityId: claim.id } as const;
  if (outcome === 'approved') {
    await withAudit((tx) => tx.expenseClaim.update({ where: { id: claim.id }, data: { status: 'approved', approvedAt: new Date() } }), {
      ...audit,
      actorId: detail.actorId,
      action: 'expense.approved',
      summary: message('Expense claim {key} approved.', { key: claimKey(claim.id) }),
    });
    await postClaim(claim.id, detail.actorId);
  } else if (outcome === 'rejected') {
    await withAudit(
      (tx) =>
        tx.expenseClaim.update({
          where: { id: claim.id },
          data: { status: 'draft', rejectedAt: new Date(), rejectedBy: detail.actorId, rejectionReason: detail.comment ?? null },
        }),
      {
        ...audit,
        actorId: detail.actorId,
        action: 'expense.rejected',
        summary: message('Expense claim {key} rejected and returned to draft.', { key: claimKey(claim.id) }),
        reason: detail.comment ?? null,
      },
    );
  } else {
    await withAudit((tx) => tx.expenseClaim.update({ where: { id: claim.id }, data: { status: 'draft' } }), {
      ...audit,
      actorId: detail.actorId,
      action: 'expense.withdrawn',
      summary: message('Expense claim {key} withdrawn.', { key: claimKey(claim.id) }),
      reason: detail.comment ?? null,
    });
  }
}

registerSubjectAdapter({ type: 'expense_claim', load: loadClaim, link: (id) => `/expenses/${id}`, onOutcome });

/* -------------------------------------------------------------------------- */
/* Views                                                                       */
/* -------------------------------------------------------------------------- */

async function viewsOf(rows: (ExpenseClaim & { receipts: Pick<ExpenseReceipt, 'id' | 'fileName' | 'contentType' | 'size' | 'createdAt'>[] })[], viewer: ExpenseViewer): Promise<ExpenseClaimView[]> {
  if (rows.length === 0) return [];
  const [users, projects, categories, settings] = await Promise.all([
    runAsSystem(() => getUsers()).catch(() => []),
    runAsSystem(() => listProjects()).catch(() => []),
    listCategories().catch(() => [] as ExpenseCategory[]),
    getTimeSettings(),
  ]);
  const nameOf = (id: string | null) => (id ? users.find((user) => user.id === id)?.name : undefined);
  const subjects = new Map<number, string>();
  await Promise.all(
    [...new Set(rows.map((row) => row.workPackageId))].map(async (workPackageId) => {
      const work = await runAsSystem(() => openProject.request<{ subject: string }>(`/work_packages/${workPackageId}`)).catch(() => null);
      if (work) subjects.set(workPackageId, work.subject);
    }),
  );
  const views: ExpenseClaimView[] = [];
  for (const row of rows) {
    const requests = row.requestId ? await requestsFor('expense_claim', row.id, viewer.id, viewer.manage) : [];
    const own = row.claimantId === viewer.id;
    const status = row.status as ExpenseClaimStatus;
    const amount = money(row.amount);
    views.push({
      id: row.id,
      claimantId: row.claimantId,
      claimantName: nameOf(row.claimantId) ?? `#${row.claimantId}`,
      projectId: String(row.projectId),
      projectName: projects.find((project) => String(project.id) === String(row.projectId))?.name ?? `#${row.projectId}`,
      workPackageId: String(row.workPackageId),
      workPackageSubject: subjects.get(row.workPackageId),
      categoryId: String(row.costTypeId),
      categoryName: categories.find((category) => category.id === String(row.costTypeId))?.name ?? `#${row.costTypeId}`,
      amount,
      currency: row.currency,
      ...(row.reportingAmount !== null
        ? {
            reportingAmount: money(row.reportingAmount),
            reportingCurrency: row.reportingCurrency ?? undefined,
            exchangeRate: row.exchangeRate === null ? undefined : Number(row.exchangeRate),
            rateDate: row.rateDate ? iso(row.rateDate) : undefined,
          }
        : {}),
      spentOn: iso(row.spentOn),
      description: row.description,
      status,
      receipts: row.receipts.map(receiptView),
      receiptRequired: amount > settings.expenses.receiptThreshold,
      submittedAt: row.submittedAt?.toISOString(),
      approvedAt: row.approvedAt?.toISOString(),
      postedAt: row.postedAt?.toISOString(),
      costEntryId: row.costEntryId === null ? undefined : String(row.costEntryId),
      postError: row.status === 'approved' ? row.postError ?? undefined : undefined,
      rejection:
        status === 'draft' && row.rejectedAt && row.rejectedBy
          ? { at: row.rejectedAt.toISOString(), by: row.rejectedBy, byName: nameOf(row.rejectedBy), reason: row.rejectionReason ?? '' }
          : undefined,
      request: requests[0],
      can: {
        edit: own && status === 'draft',
        submit: own && status === 'draft',
        withdraw: (own || viewer.manage) && status === 'submitted' && requests[0]?.status === 'pending',
        delete: own && status === 'draft',
        post: viewer.manage && status === 'approved',
      },
    });
  }
  return views;
}

const withReceipts = { receipts: { select: { id: true, fileName: true, contentType: true, size: true, createdAt: true } } } as const;

export async function claimView(id: string, viewer: ExpenseViewer): Promise<ExpenseClaimView> {
  const row = await prisma.expenseClaim.findUnique({ where: { id }, include: withReceipts });
  if (!row) throw EpmError.notFound('That claim');
  await assertMayRead(row, viewer);
  return (await viewsOf([row], viewer))[0]!;
}

export interface ClaimQuery {
  scope: 'mine' | 'all';
  status?: ExpenseClaimStatus;
  projectId?: string;
  from?: string;
  to?: string;
}

export async function listClaims(query: ClaimQuery, viewer: ExpenseViewer): Promise<ExpenseClaimView[]> {
  if (query.scope === 'all' && !viewer.manage) throw EpmError.forbidden('Every claim is for whoever manages expense claims.');
  const rows = await prisma.expenseClaim.findMany({
    where: {
      ...(query.scope === 'mine' ? { claimantId: viewer.id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.projectId ? { projectId: Number(query.projectId) } : {}),
      ...(query.from || query.to
        ? { spentOn: { ...(query.from ? { gte: date(query.from) } : {}), ...(query.to ? { lte: date(query.to) } : {}) } }
        : {}),
    },
    include: withReceipts,
    orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });
  return viewsOf(rows, viewer);
}

/* -------------------------------------------------------------------------- */
/* The finance export (BR-309)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Approved claims spent in a period, as a workbook for finance: posted ones
 * with their OpenProject cost entry, approved ones not yet posted marked so.
 */
export async function exportClaims(from: string, to: string, viewer: ExpenseViewer): Promise<Uint8Array> {
  if (!viewer.manage) throw EpmError.forbidden('The finance export is for whoever manages expense claims.');
  const claims = await listClaims({ scope: 'all', from, to }, viewer);
  const language = contextLanguage();
  const word = (source: string) => t(language, source);
  const rows = claims
    .filter((claim) => claim.status === 'posted' || claim.status === 'approved')
    .sort((a, b) => a.spentOn.localeCompare(b.spentOn) || a.id.localeCompare(b.id))
    .map((claim) => [
      claimKey(claim.id),
      claim.spentOn,
      claim.claimantName,
      claim.projectName,
      claim.workPackageSubject ? `#${claim.workPackageId} ${claim.workPackageSubject}` : `#${claim.workPackageId}`,
      claim.categoryName,
      claim.description,
      claim.amount,
      claim.currency,
      claim.status === 'posted' ? word('Posted') : word('Approved, not yet posted'),
      claim.approvedAt?.slice(0, 10) ?? '',
      claim.costEntryId ?? '',
    ]);
  return buildWorkbook(
    [
      {
        name: word('Expense claims'),
        headers: [
          word('Claim'),
          word('Date'),
          word('Claimant'),
          word('Project'),
          word('Work package'),
          word('Category'),
          word('Description'),
          word('Amount'),
          word('Currency'),
          word('Status'),
          word('Approved'),
          word('OpenProject cost entry'),
        ],
        rows,
      },
    ],
    { title: t(language, 'Expense claims from {from} to {to}', { from: dateOf(from), to: dateOf(to) }), rightToLeft: language === 'ar' },
  );
}
