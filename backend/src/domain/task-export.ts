import { csvCell } from '../lib/csv-parse.js';
import { durationToHours } from '../lib/duration.js';
import { contextLanguage, t } from '../lib/i18n.js';
import { buildWorkbook, type CellValue } from '../lib/xlsx.js';
import { idFromHref, openProject } from '../openproject/client.js';
import type { HalLink } from '../openproject/types.js';
import { fieldValue, projectFields } from './task-fields.js';

/**
 * Exporting a project's work packages — epics, tasks, subtasks, milestones —
 * as CSV or Excel, in the columns the CSV import reads, so a file can be
 * exported, edited and imported again: every row has an ID (WP<id>), its
 * parent's ID and the IDs it follows, so the hierarchy and the dependencies
 * come back whole, and imported into the same project each row overwrites its
 * work package. Columns after Predecessors are for reading only; the import
 * ignores them.
 *
 * After the fixed columns come the project's own custom fields, by name, as the
 * template has them (task-fields.ts).
 *
 * Read with the caller's own access: they export exactly what they can see.
 */

export const IMPORT_COLUMNS = [
  'ID',
  'Parent ID',
  'Type',
  'Subject',
  'Description',
  'Start date',
  'Due date',
  'Estimated hours',
  'Done %',
  'Assignee',
  'Accountable',
  'Status',
  'Priority',
  'Version',
  'Category',
  'Story points',
  'Manual scheduling',
  'Predecessors',
] as const;
const EXTRA_COLUMNS = ['Work package', 'Spent hours', 'Created', 'Updated'] as const;

export interface OpWork {
  id: number;
  lockVersion?: number;
  scheduleManually?: boolean;
  ignoreNonWorkingDays?: boolean;
  storyPoints?: number | null;
  subject: string;
  description?: { raw?: string | null } | null;
  startDate?: string | null;
  dueDate?: string | null;
  date?: string | null;
  estimatedTime?: string | null;
  spentTime?: string | null;
  percentageDone?: number | null;
  createdAt?: string;
  updatedAt?: string;
  _links: Record<string, HalLink | HalLink[] | undefined>;
}

interface OpRelation {
  id: number;
  type: string;
  _links: { from?: HalLink; to?: HalLink };
}

export const title = (links: OpWork['_links'], key: string) => {
  const link = links[key];
  return (Array.isArray(link) ? link[0]?.title : link?.title) ?? '';
};
export const href = (links: OpWork['_links'], key: string) => {
  const link = links[key];
  return (Array.isArray(link) ? link[0]?.href : link?.href) ?? null;
};
export const keyOf = (id: number | string) => `WP${id}`;

export interface ExportRows {
  header: string[];
  rows: CellValue[][];
}

export interface ProjectWork {
  items: OpWork[];
  /** Work package id → its parent's id, when the parent is in the project too. */
  parentOf: Map<string, string | null>;
  /** Successor id → predecessor id → the relation's id, both ends in the project. */
  predecessors: Map<string, Map<string, string>>;
}

/** A project's work packages and the dependencies between them, read with the caller's access. */
export async function readProjectWork(projectId: number, includeClosed: boolean): Promise<ProjectWork> {
  const [work, relations] = await Promise.all([
    openProject.getAll<OpWork>('/work_packages', {
      filters: [
        { field: 'project', operator: '=', values: [String(projectId)] },
        { field: 'status', operator: includeClosed ? '*' : 'o', values: [] },
      ],
      sortBy: [['id', 'asc']],
      pageSize: 1000,
    }),
    openProject
      .getAll<OpRelation>('/relations', {
        filters: [{ field: 'type', operator: '=', values: ['follows', 'precedes'] }],
        pageSize: 1000,
      })
      .catch(() => ({ items: [] as OpRelation[] })),
  ]);
  const ids = new Set(work.items.map((item) => String(item.id)));
  const predecessors = new Map<string, Map<string, string>>();
  for (const relation of relations.items) {
    const from = idFromHref(relation._links.from?.href);
    const to = idFromHref(relation._links.to?.href);
    if (!from || !to) continue;
    // "A follows B" and "B precedes A" both make B a predecessor of A.
    const [successor, predecessor] = relation.type === 'follows' ? [from, to] : [to, from];
    if (!ids.has(successor) || !ids.has(predecessor)) continue;
    if (!predecessors.has(successor)) predecessors.set(successor, new Map());
    predecessors.get(successor)!.set(predecessor, String(relation.id));
  }
  const parentOf = new Map<string, string | null>();
  for (const item of work.items) {
    const parent = idFromHref(href(item._links, 'parent'));
    parentOf.set(String(item.id), parent && ids.has(parent) ? parent : null);
  }
  return { items: work.items, parentOf, predecessors };
}

/** The project's work packages as rows, parents before their children. */
export async function exportRows(projectId: number, includeClosed: boolean): Promise<ExportRows> {
  const [{ items, parentOf: parents, predecessors: links }, types] = await Promise.all([
    readProjectWork(projectId, includeClosed),
    openProject.getAll<{ id: number }>(`/projects/${projectId}/types`, { pageSize: 200 }),
  ]);
  const { fields } = await projectFields(projectId, types.items.map((type) => String(type.id)));
  const predecessors = new Map([...links].map(([successor, before]) => [successor, [...before.keys()].map(keyOf)]));

  // Parents before children, so the file reads top-down and imports in one pass.
  const parentOf = (item: OpWork) => parents.get(String(item.id)) ?? null;
  const children = new Map<string | null, OpWork[]>();
  for (const item of items) children.set(parentOf(item), [...(children.get(parentOf(item)) ?? []), item]);
  const ordered: OpWork[] = [];
  const placed = new Set<number>();
  const visit = (parent: string | null) => {
    for (const item of children.get(parent) ?? []) {
      if (placed.has(item.id)) continue;
      placed.add(item.id);
      ordered.push(item);
      visit(String(item.id));
    }
  };
  visit(null);
  // Anything a loop left out (it cannot happen upstream, but nothing is dropped).
  for (const item of items) if (!placed.has(item.id)) ordered.push(item);

  const rows = ordered.map((item): CellValue[] => {
    const milestone = item.date !== undefined && item.startDate === undefined && item.dueDate === undefined;
    const parent = parentOf(item);
    const hours = durationToHours(item.estimatedTime);
    const spent = durationToHours(item.spentTime);
    return [
      keyOf(item.id),
      parent ? keyOf(parent) : '',
      title(item._links, 'type'),
      item.subject,
      item.description?.raw ?? '',
      milestone ? '' : (item.startDate ?? ''),
      milestone ? (item.date ?? '') : (item.dueDate ?? ''),
      hours === undefined ? '' : Math.round(hours * 100) / 100,
      item.percentageDone ?? '',
      title(item._links, 'assignee'),
      title(item._links, 'responsible'),
      title(item._links, 'status'),
      title(item._links, 'priority'),
      title(item._links, 'version'),
      title(item._links, 'category'),
      item.storyPoints ?? '',
      item.scheduleManually ? 'Yes' : 'No',
      (predecessors.get(String(item.id)) ?? []).join(';'),
      ...fields.map((field) => fieldValue(item as unknown as Record<string, unknown>, field).text),
      `#${item.id}`,
      spent === undefined ? '' : Math.round(spent * 100) / 100,
      item.createdAt?.slice(0, 10) ?? '',
      item.updatedAt?.slice(0, 10) ?? '',
    ];
  });
  return { header: [...IMPORT_COLUMNS, ...fields.map((field) => field.name), ...EXTRA_COLUMNS], rows };
}

export function asCsv(data: ExportRows): string {
  // A byte-order mark, so Excel opens it as UTF-8 (Arabic and accented names intact).
  return `﻿${[data.header, ...data.rows].map((cells) => cells.map((cell) => csvCell(cell === null || cell === undefined ? '' : (cell as string | number))).join(',')).join('\r\n')}\r\n`;
}

export function asWorkbook(data: ExportRows, projectName: string): Uint8Array {
  const language = contextLanguage();
  return buildWorkbook([{ name: t(language, 'Tasks'), headers: data.header, rows: data.rows }], {
    title: projectName,
    rightToLeft: language === 'ar',
  });
}
