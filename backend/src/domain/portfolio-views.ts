import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { runAsSystem } from '../auth/context.js';
import { prisma } from '../db/prisma.js';
import { referenceCache } from '../lib/cache.js';
import { EpmError } from '../lib/errors.js';
import { idFromHref, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import { recordAuditQuietly } from './audit.js';
import { AUTOMATION_ROLE_NAME } from './automation-account.js';
import { modelFacts, type ModelFacts } from './measure-facts.js';
import type { Period, Viewer } from './measures.js';
import { DEFAULT_COLUMNS, OVERVIEW_COLUMNS, portfolioOverview, type PortfolioOverview } from './portfolio-overview.js';
import { PERIOD_PRESETS, periodFor, type PeriodPreset } from './report-schedule.js';
import { listOf, message } from '../lib/i18n.js';

/**
 * Saved portfolio views (BR-203).
 *
 * A view is a set of projects — some portfolios, some named projects, or all
 * of them, optionally only those at a given health — with the period and
 * columns to show them in, kept private, shared with whoever holds given
 * project roles, or public. Sharing a view shares the selection, never the
 * projects: each person sees it with their own access, and a project in it
 * they cannot see is left out and counted, not an error.
 *
 * "Shared with a role" means: anyone who holds one of those roles on at least
 * one project the view selects (on any project, for a view of all projects).
 */

export type Visibility = 'private' | 'roles' | 'public';

const definitionSchema = z.object({
  portfolioIds: z.array(z.string().min(1)).max(50).default([]),
  projectIds: z.array(z.string().regex(/^\d+$/)).max(500).default([]),
  health: z.array(z.enum(['healthy', 'warning', 'critical'])).max(3).default([]),
  periodPreset: z.enum(PERIOD_PRESETS).default('last-12-weeks'),
  columns: z.array(z.enum(OVERVIEW_COLUMNS)).min(1, 'Show at least one column.').max(OVERVIEW_COLUMNS.length).default(DEFAULT_COLUMNS),
});

export const viewInput = z
  .object({
    name: z.string().trim().min(1, 'A view needs a name.').max(120),
    description: z.string().trim().max(1000).optional().nullable(),
    visibility: z.enum(['private', 'roles', 'public']).default('private'),
    roleIds: z.array(z.string().regex(/^\d+$/)).max(50).default([]),
    definition: definitionSchema,
  })
  .superRefine((input, context) => {
    if (input.visibility === 'roles' && input.roleIds.length === 0) {
      context.addIssue({ code: 'custom', path: ['roleIds'], message: 'Name the roles it is shared with.' });
    }
  });

export type ViewInput = z.infer<typeof viewInput>;
export type ViewDefinition = ViewInput['definition'];

type ViewRow = Prisma.PortfolioViewGetPayload<object>;

export interface PortfolioViewSummary {
  id: string;
  name: string;
  description: string | null;
  visibility: Visibility;
  roleIds: string[];
  roles: { id: string; name: string }[];
  owner: { id: string; name: string };
  mine: boolean;
  canEdit: boolean;
  definition: ViewDefinition;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Who may see a view                                                          */
/* -------------------------------------------------------------------------- */

/** The roles a person holds, project by project, from their memberships upstream. */
async function rolesByProject(userId: string): Promise<Map<number, Set<string>>> {
  return referenceCache.get(
    `portfolio-view-roles:${userId}`,
    () =>
      runAsSystem(async () => {
        const memberships = await openProject.getAll<{ _links?: Record<string, HalLink | HalLink[] | undefined> }>(
          '/memberships',
          { filters: [{ field: 'principal', operator: '=', values: [userId] }], pageSize: 200 },
        );
        const result = new Map<number, Set<string>>();
        for (const membership of memberships.items) {
          const project = membership._links?.project;
          const projectId = Number(idFromHref((Array.isArray(project) ? project[0] : project)?.href));
          if (!Number.isFinite(projectId)) continue;
          const roles = membership._links?.roles;
          const ids = (Array.isArray(roles) ? roles : roles ? [roles] : [])
            .map((role) => idFromHref(role.href))
            .filter((id): id is string => Boolean(id));
          const held = result.get(projectId) ?? new Set<string>();
          for (const id of ids) held.add(id);
          result.set(projectId, held);
        }
        return result;
      }),
    60_000,
  );
}

/**
 * Forgets the roles remembered for whoever's membership EPM just changed — all
 * of them, as a change can come from either side of a membership. A view
 * shared with a role then reaches someone given it at once; a change made in
 * OpenProject directly is seen within the minute.
 */
export function forgetViewRoles(): void {
  referenceCache.invalidatePrefix('portfolio-view-roles');
}

/**
 * Whether a person may see a view. Pure, so the rule can be checked on its
 * own: the owner always; anyone for a public view; for a role-scoped view,
 * anyone holding one of its roles on a project it selects.
 */
export function maySeeView(
  view: { ownerId: string; visibility: string; roleIds: string[] },
  viewerId: string,
  rolesOnSelectedProjects: Set<string>,
): boolean {
  if (view.ownerId === viewerId) return true;
  if (view.visibility === 'public') return true;
  if (view.visibility === 'roles') return view.roleIds.some((id) => rolesOnSelectedProjects.has(id));
  return false;
}

/** The active projects a definition selects: its portfolios' and its named ones, or every project if it names none. */
export function projectsOf(definition: Pick<ViewDefinition, 'portfolioIds' | 'projectIds'>, facts: Pick<ModelFacts, 'projects'>): number[] {
  const portfolios = new Set(definition.portfolioIds);
  const named = new Set(definition.projectIds.map(Number));
  const everything = portfolios.size === 0 && named.size === 0;
  return [...facts.projects.values()]
    .filter((project) => project.active && (everything || named.has(project.id) || (project.portfolioId !== null && portfolios.has(project.portfolioId))))
    .map((project) => project.id);
}

async function rolesOnProjects(userId: string, projectIds: number[] | 'all'): Promise<Set<string>> {
  const byProject = await rolesByProject(userId).catch(() => new Map<number, Set<string>>());
  const held = new Set<string>();
  for (const [projectId, roles] of byProject) {
    if (projectIds !== 'all' && !projectIds.includes(projectId)) continue;
    for (const role of roles) held.add(role);
  }
  return held;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

const definitionOf = (row: ViewRow): ViewDefinition => definitionSchema.parse(row.definition ?? {});

/**
 * The roles a view can be shared with: those that can be held on a project
 * (OpenProject's `grantable`), less the automation account's. A global role,
 * or one that only shares a work package or a query, is never held through a
 * project membership, so a view shared with it would reach nobody.
 */
async function shareableRoles(): Promise<Map<string, string>> {
  return referenceCache.get(
    'portfolio-view-shareable-roles',
    () =>
      runAsSystem(async () => {
        const roles = await openProject.getAll<{ id: number; name: string }>('/roles', {
          filters: [{ field: 'grantable', operator: '=', values: ['t'] }],
          pageSize: 200,
        });
        return new Map(
          roles.items.filter((role) => role.name !== AUTOMATION_ROLE_NAME).map((role) => [String(role.id), role.name]),
        );
      }),
    10 * 60_000,
  ).catch(() => new Map<string, string>());
}

async function roleNames(): Promise<Map<string, string>> {
  return referenceCache.get(
    'portfolio-view-role-names',
    () =>
      runAsSystem(async () => {
        const roles = await openProject.getAll<{ id: number; name: string }>('/roles', { pageSize: 200 });
        return new Map(roles.items.map((role) => [String(role.id), role.name]));
      }),
    10 * 60_000,
  ).catch(() => new Map<string, string>());
}

async function summarise(row: ViewRow, viewerId: string, manager: boolean): Promise<PortfolioViewSummary> {
  const [facts, names] = await Promise.all([modelFacts(), roleNames()]);
  const mine = row.ownerId === viewerId;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility as Visibility,
    roleIds: row.roleIds,
    roles: row.roleIds.map((id) => ({ id, name: names.get(id) ?? `Role ${id}` })),
    owner: { id: row.ownerId, name: facts.users.get(Number(row.ownerId))?.name ?? `User ${row.ownerId}` },
    mine,
    canEdit: mine || (manager && row.visibility !== 'private'),
    definition: definitionOf(row),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function visibleTo(row: ViewRow, viewerId: string): Promise<boolean> {
  if (row.ownerId === viewerId || row.visibility === 'public') return true;
  if (row.visibility !== 'roles') return false;
  const definition = definitionOf(row);
  const selects =
    definition.portfolioIds.length === 0 && definition.projectIds.length === 0 ? 'all' : projectsOf(definition, await modelFacts());
  return maySeeView(row, viewerId, await rolesOnProjects(viewerId, selects));
}

/** The views this person may see: their own, those shared with their roles, and public ones. */
export async function listViews(viewerId: string, manager: boolean): Promise<PortfolioViewSummary[]> {
  const rows = await prisma.portfolioView.findMany({
    where: { OR: [{ ownerId: viewerId }, { visibility: { in: ['roles', 'public'] } }] },
    orderBy: [{ name: 'asc' }],
  });
  const visible: ViewRow[] = [];
  for (const row of rows) if (await visibleTo(row, viewerId)) visible.push(row);
  return Promise.all(visible.map((row) => summarise(row, viewerId, manager)));
}

/** A view this person may see; one they may not is not found, exactly like one that does not exist. */
async function readable(id: string, viewerId: string): Promise<ViewRow> {
  const row = await prisma.portfolioView.findUnique({ where: { id } });
  if (!row || !(await visibleTo(row, viewerId))) throw EpmError.notFound('That portfolio view');
  return row;
}

export async function getView(id: string, viewerId: string, manager: boolean): Promise<PortfolioViewSummary> {
  return summarise(await readable(id, viewerId), viewerId, manager);
}

/** The view for this person: the projects it selects that they can see, over its period unless one is asked for. */
export async function viewOverview(
  id: string,
  viewerId: string,
  viewer: Viewer,
  today: string,
  period?: Period,
): Promise<PortfolioOverview> {
  const row = await readable(id, viewerId);
  const definition = definitionOf(row);
  const facts = await modelFacts();
  return portfolioOverview(
    { kind: 'view', id: row.id, name: row.name, projectIds: projectsOf(definition, facts), health: definition.health },
    viewer,
    period ?? periodFor(definition.periodPreset as PeriodPreset, today),
    today,
  );
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

async function checkReferences(input: ViewInput): Promise<void> {
  const facts = await modelFacts();
  const unknownPortfolios = input.definition.portfolioIds.filter((id) => !facts.portfolios.has(id));
  if (unknownPortfolios.length > 0) throw EpmError.badRequest(message('Not portfolios EPM knows: {ids}.', { ids: listOf(unknownPortfolios) }));
  if (input.visibility === 'roles') {
    const shareable = await shareableRoles();
    const unknownRoles = input.roleIds.filter((id) => !shareable.has(id));
    if (unknownRoles.length > 0) {
      throw EpmError.badRequest(message('Not roles a project member can hold: {ids}.', { ids: listOf(unknownRoles) }));
    }
  }
}

function journal(viewId: string, action: string, summary: string, actorId: string, extra: { before?: unknown; after?: unknown } = {}) {
  return recordAuditQuietly([{ actorId, entityType: 'portfolio_view', entityId: viewId, action, summary, ...extra }]);
}

export async function createView(raw: unknown, ownerId: string): Promise<PortfolioViewSummary> {
  const input = viewInput.parse(raw);
  await checkReferences(input);
  const row = await prisma.portfolioView.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      ownerId,
      visibility: input.visibility,
      roleIds: input.visibility === 'roles' ? input.roleIds : [],
      definition: input.definition as unknown as Prisma.InputJsonValue,
    },
  });
  await journal(row.id, 'portfolio_view.created', `Portfolio view "${row.name}" created (${row.visibility})`, ownerId, { after: input });
  return summarise(row, ownerId, false);
}

/** Changed by its owner; a shared one also by whoever manages portfolios. */
async function editable(id: string, actorId: string, manager: boolean): Promise<ViewRow> {
  const row = await readable(id, actorId);
  if (row.ownerId !== actorId && !(manager && row.visibility !== 'private')) {
    throw EpmError.forbidden('Only whoever made this view, or someone who manages portfolios, may change it.');
  }
  return row;
}

export async function updateView(id: string, raw: unknown, actorId: string, manager: boolean): Promise<PortfolioViewSummary> {
  const existing = await editable(id, actorId, manager);
  const input = viewInput.parse(raw);
  await checkReferences(input);
  const row = await prisma.portfolioView.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description ?? null,
      visibility: input.visibility,
      roleIds: input.visibility === 'roles' ? input.roleIds : [],
      definition: input.definition as unknown as Prisma.InputJsonValue,
      version: { increment: 1 },
    },
  });
  const shared = existing.visibility !== row.visibility ? ` — now ${row.visibility}` : '';
  await journal(id, 'portfolio_view.updated', `Portfolio view "${row.name}" changed${shared}`, actorId, {
    before: { name: existing.name, visibility: existing.visibility, roleIds: existing.roleIds, definition: existing.definition },
    after: input,
  });
  return summarise(row, actorId, manager);
}

export async function deleteView(id: string, actorId: string, manager: boolean): Promise<void> {
  const existing = await editable(id, actorId, manager);
  await prisma.portfolioView.delete({ where: { id } });
  await journal(id, 'portfolio_view.deleted', `Portfolio view "${existing.name}" deleted`, actorId, {
    before: { name: existing.name, visibility: existing.visibility, roleIds: existing.roleIds, definition: existing.definition },
  });
}

/** What the editor offers: the project roles a view can be shared with. Projects and portfolios come from the caller's own lists. */
export async function viewOptions(): Promise<{ roles: { id: string; name: string }[]; columns: string[] }> {
  const roles = [...(await shareableRoles())].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  return { roles, columns: [...OVERVIEW_COLUMNS] };
}
