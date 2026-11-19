import { prisma } from '../db/prisma.js';
import { EpmError, OpenProjectError } from '../lib/errors.js';
import { message } from '../lib/i18n.js';
import { openProject } from '../openproject/client.js';

/**
 * Time that belongs to no one task: scrums and meetings, and support.
 *
 * OpenProject 17 keeps every hour on a work package (or one of its own
 * meetings, which EPM's meetings are not), so time spent in a stand-up or
 * answering support calls needs a task to stand on. Each project keeps one of
 * each, made the first time someone logs that kind of time there, and found by
 * its title afterwards. The person logging time chooses "Scrums & meetings" or
 * "Support", the project and the hours, and writes what it was; they never
 * have to hunt for a task, and the project's time and health still see the
 * hours.
 *
 * Made with the caller's own rights: EPM's service account may not add work.
 * Somebody who may not add tasks to the project is told who can, once; after
 * the first person makes it, everyone logs against it.
 */

export type TimeKind = 'project' | 'meeting' | 'support';

/** The titles the tasks are made with, and found by. Data, so the same in every language. */
export const STANDING_TASK_SUBJECT: Record<Exclude<TimeKind, 'project'>, string> = {
  meeting: 'Scrums & meetings',
  support: 'Support',
};

const DESCRIPTION: Record<Exclude<TimeKind, 'project'>, string> = {
  meeting:
    'EPM keeps this task for time spent in scrums, stand-ups and meetings on this project. Log it from Log time → Scrums & meetings, and say in the description what the meeting was.',
  support:
    'EPM keeps this task for support time on this project. Log it from Log time → Support, and say in the description what was supported.',
};

interface WorkPackageLite {
  id: number;
  subject: string;
}

async function findStanding(projectId: string, subject: string, signal?: AbortSignal): Promise<string | undefined> {
  const page = await openProject.getCollection<WorkPackageLite>(
    '/work_packages',
    {
      filters: [
        { field: 'project', operator: '=', values: [projectId] },
        { field: 'status', operator: 'o', values: [] },
        { field: 'subjectOrId', operator: '**', values: [subject] },
      ],
      sortBy: [['id', 'asc']],
      pageSize: 20,
    },
    signal,
  );
  const match = (page._embedded?.elements ?? []).find((item) => item.subject.trim().toLowerCase() === subject.toLowerCase());
  return match ? String(match.id) : undefined;
}

/**
 * The project's task for this kind of time: found, or made with the caller's
 * rights. One person at a time per project and kind, so two people logging
 * their first meeting together do not make two.
 */
export async function standingTaskFor(projectId: string, kind: Exclude<TimeKind, 'project'>, signal?: AbortSignal): Promise<string> {
  if (!/^\d+$/.test(projectId)) throw EpmError.badRequest('That project is not valid.');
  const subject = STANDING_TASK_SUBJECT[kind];

  const existing = await findStanding(projectId, subject, signal);
  if (existing) return existing;

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`epm.standing-task:${projectId}:${kind}`}))`;
      const madeMeanwhile = await findStanding(projectId, subject, signal);
      if (madeMeanwhile) return madeMeanwhile;
      try {
        const created = await openProject.request<WorkPackageLite>(`/projects/${projectId}/work_packages`, {
          method: 'POST',
          query: { notify: 'false' },
          once: true,
          body: { subject, description: { format: 'markdown', raw: DESCRIPTION[kind] } },
          signal,
        });
        return String(created.id);
      } catch (error) {
        if (error instanceof OpenProjectError && (error.upstreamStatus === 403 || error.upstreamStatus === 422)) {
          throw EpmError.forbidden(
            message(
              'This project has no “{task}” task yet, and you cannot add tasks to it. Ask whoever runs the project to log some of this time first, which makes it, or choose a task.',
              { task: subject },
            ),
          );
        }
        throw error;
      }
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
}
