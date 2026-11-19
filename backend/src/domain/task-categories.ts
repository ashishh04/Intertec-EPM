import { runAsSystem } from '../auth/context.js';
import { isManagementRole, type AppRole } from '../auth/roles.js';
import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { appLog } from '../lib/log.js';
import { openProject } from '../openproject/client.js';

/**
 * Task categories: what kind of work a task is — development, testing, review
 * and so on — so that work can be handed out and found by the kind of person
 * who does it. A reviewer looks for review tasks, a tester for testing ones,
 * and a manager who reviews but does not build sees only what is theirs.
 *
 * OpenProject's own "Category" is kept per project, each project with its own
 * list, so "Review" in one project is not "Review" in the next and nothing can
 * ask for every review task at once. The categories are therefore one list
 * custom field for every project and every type, which EPM makes itself the
 * first time it is needed (through the catalogue add-on, which its service
 * account may use for custom fields) and then finds by name, with its choices,
 * through the calculated-fields add-on. An administrator can add or remove
 * choices in Administration → Custom fields (keep the field's name); EPM reads
 * whatever the field offers.
 */

export const CATEGORY_FIELD_NAME = 'Work category';

/** The choices a new field starts with: the disciplines a delivery team splits work by. */
export const DEFAULT_CATEGORIES = [
  'Analysis',
  'Design',
  'Development',
  'Testing',
  'Review',
  'Documentation',
  'Deployment',
  'Support',
  'Management',
];

export interface TaskCategoryField {
  /** The work package attribute, e.g. `customField12`. */
  key: string;
  options: { id: string; name: string }[];
}

let cached: { at: number; ttl: number; value: Promise<TaskCategoryField | null> } | undefined;
let knownKey: string | undefined;

/** The field's attribute once it is known, for the task mapping, which cannot wait for it. */
export function categoryKey(): string | undefined {
  return knownKey;
}

interface DescribedField {
  id: number;
  name: string;
  format: string;
  /** A list's choices, by custom option id, in their order. */
  options: Record<string, string> | null;
}

/**
 * The field, with its choices and their ids, from the calculated-fields add-on,
 * which lists every work package custom field and which EPM's service account
 * may read. A work package schema names a list's field but not its choices (only
 * a create form does, and the service account may not open one).
 */
async function findField(): Promise<TaskCategoryField | null> {
  const described = await openProject.request<{ fields?: DescribedField[] }>('/epm_admin/calculated/fields', {
    root: true,
    timeoutMs: 60_000,
  });
  const field = (described.fields ?? []).find((entry) => entry.name === CATEGORY_FIELD_NAME && entry.format === 'list');
  if (!field) return null;
  const options = Object.entries(field.options ?? {})
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => Number(a.id) - Number(b.id));
  return { key: `customField${field.id}`, options };
}

/** Makes the field: a list, for every project and every type, usable as a filter. */
async function createField(): Promise<void> {
  await openProject.request('/epm_admin/catalog/custom-fields', {
    root: true,
    method: 'POST',
    once: true,
    timeoutMs: 120_000,
    body: {
      name: CATEGORY_FIELD_NAME,
      fieldFormat: 'list',
      possibleValues: DEFAULT_CATEGORIES.join('\n'),
      isRequired: false,
      isForAll: true,
      typeIds: [],
      isFilter: true,
    },
  });
  appLog.info({ field: CATEGORY_FIELD_NAME, choices: DEFAULT_CATEGORIES.length }, 'Task category field created');
}

async function resolve(): Promise<TaskCategoryField | null> {
  return runAsSystem(async () => {
    const found = await findField();
    if (found) return found;
    // One server makes it: the check and the create under one lock, so two
    // servers starting together cannot both add a field of the same name.
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('epm.task-category-field'))`;
        if (await findField()) return;
        await createField();
      },
      { timeout: 150_000, maxWait: 20_000 },
    );
    return findField();
  });
}

/**
 * The category field, made if it is missing. Kept ten minutes, so choices an
 * administrator changes show within that; a failure is kept half a minute.
 */
export function taskCategoryField(): Promise<TaskCategoryField | null> {
  if (cached && Date.now() - cached.at < cached.ttl) return cached.value;
  const value = resolve()
    .then((field) => {
      knownKey = field?.key;
      if (!field) cached = { at: Date.now(), ttl: 30_000, value: Promise.resolve(null) };
      return field;
    })
    .catch((error: unknown) => {
      appLog.warn({ err: error }, 'Task categories are not available');
      cached = { at: Date.now(), ttl: 30_000, value: Promise.resolve(null) };
      return null;
    });
  cached = { at: Date.now(), ttl: 10 * 60_000, value };
  return value;
}

/**
 * Work only those who lead it do: reviewing, and managing. In project
 * management practice a deliverable is reviewed and accepted by whoever is
 * accountable for it — the project manager and those above — not by the team
 * that built it, so a developer cannot pass their own work. Matched by word,
 * whatever else the choice is called: "Review", "Code review", "Management".
 */
const LEADERSHIP_WORK = /\b(review|management)\b/i;

/** Whether a category is leadership's work only (`MANAGEMENT_ROLES`). */
export function isManagersOnly(name: string | null | undefined): boolean {
  return Boolean(name && LEADERSHIP_WORK.test(name));
}

/** Whether someone in this role may do work of this category. */
export function mayDoCategory(role: AppRole, name: string | null | undefined): boolean {
  return isManagementRole(role) || !isManagersOnly(name);
}

/** A work package's category, by name, from its links; undefined when it has none. */
export function categoryNameOf(workPackage: { _links?: unknown }, field: TaskCategoryField): string | undefined {
  const links = workPackage._links as Record<string, { href?: string | null; title?: string } | undefined> | undefined;
  const link = links?.[field.key];
  return link?.href ? link.title : undefined;
}

/**
 * Refuses work on a review or management task to someone who does not lead
 * work: logging time on it, or completing it. Says which category, and what to
 * do instead.
 */
export async function assertMayDoCategory(
  role: AppRole,
  workPackage: { _links?: unknown },
  action: 'log' | 'close',
): Promise<void> {
  if (isManagementRole(role)) return;
  const field = await taskCategoryField();
  if (!field) return;
  const category = categoryNameOf(workPackage, field);
  if (!isManagersOnly(category)) return;
  throw EpmError.forbidden(
    action === 'log'
      ? message('Only managers log time on {category} tasks. Log your time on the task you worked on, or ask the project manager to change this task’s category.', { category })
      : message('Only managers complete {category} tasks. Ask the project manager to review and close it.', { category }),
  );
}
