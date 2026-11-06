import { runAsSystem } from '../auth/context.js';
import type { Permission } from '../auth/permissions.js';
import { isStoredRole, ROLE_PERMISSIONS } from '../auth/roles.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { message } from '../lib/i18n.js';
import { appLog } from '../lib/log.js';
import { openProject } from '../openproject/client.js';
import { discardLevelling, proposeLevelling } from './levelling-store.js';
import { notifyPeople } from './notifications.js';
import { loadResourceShared } from './resources-store.js';

/**
 * BR-113, the second half: when someone becomes unavailable, their work is
 * proposed new dates — never moved unasked (the team's decision, 19 Oct 2026).
 *
 * Time off entered, changed or imported for a person who has open work in
 * those days makes a levelling proposal for that person alone: the same
 * proposal levelling makes (BR-111), with availability already reduced by the
 * absence, so the work that no longer fits moves after it and its successors
 * follow. Planners are told; one of them previews it and applies it all or
 * nothing, with a single undo (BR-112). Pinned, started and parent work stays.
 */

export interface Absence {
  personId: string;
  startsOn: string;
  endsOn: string;
}

export interface AbsenceProposal {
  personId: string;
  runId: string | null;
  moves: number;
}

const iso = (value: string | Date) => (typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));

/** Whether the person has open work dated within the absence that is still ahead. */
async function hasWorkInside(absence: Absence): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  if (absence.endsOn < today) return false;
  const data = await loadResourceShared();
  return data.facts.workPackages.some((work) => {
    if (work.isClosed || String(work.assigneeId) !== absence.personId) return false;
    const start = work.startDate ?? work.dueDate;
    const due = work.dueDate ?? work.startDate;
    return Boolean(start && due && start <= absence.endsOn && due >= absence.startsOn);
  });
}

/**
 * Who is told: everyone who plans resources, whichever way they hold it — a
 * grant, a role that carries it (Manager), or being an administrator, named in
 * the configuration or on the instance — and the owners of the projects
 * concerned who may open the proposal. Levelling is for planners and for those
 * who staff people; an owner who is neither was sent to a page that refused
 * them. External people are left out: they see only the portal.
 */
async function plannersFor(projectIds: string[]): Promise<string[]> {
  const [grants, profiles, owners, administrators] = await Promise.all([
    prisma.epmPermissionGrant.findMany({
      where: { permission: { in: ['resources:plan', 'employees:manage'] } },
      select: { openProjectId: true, permission: true },
    }),
    // Whoever holds an EPM role, and whoever is external, whose role is set
    // aside while they are.
    prisma.userProfile.findMany({
      where: { OR: [{ appRole: { not: null } }, { external: true }] },
      select: { openProjectId: true, appRole: true, external: true },
    }),
    projectIds.length > 0
      ? prisma.projectProfile.findMany({ where: { openProjectId: { in: projectIds } }, select: { ownerId: true } })
      : Promise.resolve([] as { ownerId: string | null }[]),
    // From the add-on, as the service account: API v3 shows who is an
    // administrator to administrators alone. The others are still told when it
    // cannot be read.
    runAsSystem(() => openProject.request<{ ids: string[] }>('/epm_admin/users/administrators', { root: true }))
      .then((answer) => answer.ids.map(String))
      .catch(() => [] as string[]),
  ]);

  const external = new Set(profiles.filter((row) => row.external).map((row) => row.openProjectId));
  const holders = (permission: Permission) =>
    new Set([
      ...env.EPM_ADMIN_USER_IDS,
      ...administrators,
      ...grants.filter((row) => row.permission === permission).map((row) => row.openProjectId),
      ...profiles
        .filter((row) => !row.external && isStoredRole(row.appRole) && ROLE_PERMISSIONS[row.appRole].includes(permission))
        .map((row) => row.openProjectId),
    ]);
  const planners = holders('resources:plan');
  const staffers = holders('employees:manage');
  // An owner who plans is among the planners already; one who staffs people
  // may open the proposal too.
  const owning = owners.map((row) => row.ownerId).filter((id): id is string => id !== null && staffers.has(id));
  return [...new Set([...planners, ...owning])].filter((id) => !external.has(id));
}

/**
 * Proposes new dates for a person's work around an absence, and tells the
 * planners. Returns the proposal, or none when nothing of theirs needs to move.
 */
export async function proposeForAbsence(absence: Absence, actorId: string): Promise<AbsenceProposal> {
  if (!(await hasWorkInside(absence))) return { personId: absence.personId, runId: null, moves: 0 };

  // Every project's work may be proposed: nothing is written until a planner
  // applies it, and applying writes with that planner's own access.
  // Far enough to see past the absence, with room after it to put the work.
  const weeksAway = Math.ceil((Date.parse(`${absence.endsOn}T00:00:00Z`) - Date.now()) / (7 * 86_400_000));
  const horizonWeeks = Math.min(104, Math.max(26, weeksAway + 12));
  const run = await proposeLevelling(
    { scope: { kind: 'people', people: [absence.personId] }, horizonWeeks },
    { id: actorId, mayEdit: () => true },
  );
  if (run.moves.length === 0) {
    await discardLevelling(run.id, actorId).catch(() => undefined);
    return { personId: absence.personId, runId: null, moves: 0 };
  }

  const projectIds = [...new Set(run.moves.map((move) => move.projectId))];
  const recipients = await plannersFor(projectIds);
  await notifyPeople({
    recipients: [...new Set([...recipients, actorId])],
    category: 'project_update',
    title: message('{name} is away from {from} to {to}: new dates proposed for {count, plural, one {# work package} other {# work packages}}', {
      name: run.scope.name,
      from: absence.startsOn,
      to: absence.endsOn,
      count: run.moves.length,
    }),
    body: message('Nothing has moved yet. Review the proposal under Resources → Levelling, and apply it or discard it.'),
    link: `/resources?tab=levelling&run=${run.id}`,
    severity: 'warning',
    dedupeKey: `absence-proposal:${run.id}`,
  }).catch(() => 0);

  return { personId: absence.personId, runId: run.id, moves: run.moves.length };
}

/** Runs `proposeForAbsence` without holding up the request that recorded the absence. */
export function proposeForAbsenceLater(absence: Absence, actorId: string): void {
  void proposeForAbsence(absence, actorId).catch((error) =>
    appLog.warn({ err: error, personId: absence.personId }, 'Could not propose new dates for an absence.'),
  );
}

/** The absences an HR import created or changed since `since`, one per person (the widest stretch). */
export async function absencesChangedSince(since: Date): Promise<Absence[]> {
  const rows = await prisma.timeOff.findMany({ where: { updatedAt: { gte: since } }, select: { openProjectId: true, startsOn: true, endsOn: true } });
  const byPerson = new Map<string, Absence>();
  for (const row of rows) {
    const current = byPerson.get(row.openProjectId);
    const startsOn = iso(row.startsOn);
    const endsOn = iso(row.endsOn);
    byPerson.set(row.openProjectId, {
      personId: row.openProjectId,
      startsOn: current && current.startsOn < startsOn ? current.startsOn : startsOn,
      endsOn: current && current.endsOn > endsOn ? current.endsOn : endsOn,
    });
  }
  return [...byPerson.values()];
}
