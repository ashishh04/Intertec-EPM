import { AsyncResource } from 'node:async_hooks';

import { env } from '../config/env.js';
import { enqueueEmail } from '../email/outbox.js';
import { resolveRecipient } from '../email/recipients.js';
import { referenceCache } from '../lib/cache.js';
import { appLog } from '../lib/log.js';
import { linkId, openProject } from '../openproject/client.js';
import type { OpMembership, OpPrincipal, OpWorkPackage } from '../openproject/types.js';
import type { UserPreferences } from '../types/epm.js';

/**
 * Telling people about meetings, news, wiki pages and documents.
 *
 * These exist because the switches in Settings have to mean something. A
 * "Notify me about news" toggle that nothing reads is worse than no toggle — it
 * is a promise the product does not keep — so every one of them has a producer
 * here, and each passes its own `gate` to the outbox. The outbox then applies
 * that switch, the master email switch, the pause window and out-of-office, which
 * is why none of that is repeated below.
 *
 * Recipients come from OpenProject's memberships, not from anything EPM stores.
 * That matters for one reason above all: somebody removed from a project must
 * stop hearing about it, and the only record that knows is the membership list.
 *
 * Nothing here is allowed to throw. A notification is a side effect of something
 * that has already happened and been committed; a mail failure must never turn a
 * saved wiki page into a 500.
 */

/**
 * An execution context with no session in it.
 *
 * The client reads the caller's token from async-local storage and falls back to
 * the service key when there is none. Membership lists have to be read as the
 * service: the person posting an announcement may not be permitted to read the
 * full member list of the project they are posting to, and the announcement still
 * has to reach everybody in it.
 *
 * Created at module load, before any request exists, so running inside it puts
 * the client back in the no-session case whoever called.
 */
const serviceScope = new AsyncResource('epm.collaboration.notifications');
const asService = <T>(fn: () => Promise<T>): Promise<T> => serviceScope.runInAsyncScope(fn);

/**
 * How many people one event may reach.
 *
 * A bound, not a policy. An organisation-wide announcement genuinely is addressed
 * to everybody, so the cap is high — but a runaway that mails ten thousand rows in
 * one request has to stop somewhere, and stopping at a number is better than
 * stopping when the database fills.
 */
const MAX_RECIPIENTS = 500;

/** Users in a project, from its memberships. Groups are skipped — they are not people. */
async function projectMembers(projectId: string): Promise<string[]> {
  return referenceCache.get(
    `project-members:${projectId}`,
    async () => {
      const memberships = await asService(() =>
        openProject.getAll<OpMembership>(
          '/memberships',
          { filters: [{ field: 'project', operator: '=', values: [projectId] }], pageSize: 200 },
          {},
        ),
      ).catch(() => ({ items: [] as OpMembership[] }));

      const ids = new Set<string>();
      for (const membership of memberships.items) {
        const principalId = linkId(membership._links, 'principal');
        // A membership's principal can be a group or a placeholder. Only a real
        // user has an address, and the outbox would drop the rest anyway — but
        // dropping them here keeps the count in the log honest.
        const type = (Array.isArray(membership._links?.principal)
          ? membership._links?.principal[0]
          : membership._links?.principal)?.href;
        if (principalId && type?.includes('/users/')) ids.add(principalId);
      }
      return [...ids];
    },
    // Two minutes. Long enough to cost nothing on a burst of edits, short enough
    // that somebody just added to a project hears about the next thing.
    2 * 60_000,
  );
}

/** Everybody with an active account, for an organisation-wide announcement. */
async function everyone(): Promise<string[]> {
  return referenceCache.get(
    'all-active-users',
    async () => {
      /*
       * Unfiltered, then narrowed here.
       *
       * `/principals` accepts a `type` filter, but a filter this depends on is a
       * filter that can be rejected — and the failure would be silent: the walk
       * catches, returns nothing, and organisation-wide announcements simply stop
       * reaching anybody with no error to notice. The directory read in
       * `mapping/users.ts` narrows client-side for the same reason, and is proven
       * against this instance.
       */
      const principals = await asService(() =>
        openProject.getAll<OpPrincipal>('/principals', { pageSize: 200 }, {}),
      ).catch(() => ({ items: [] as OpPrincipal[] }));

      return principals.items
        .filter((principal) => principal._type === 'User')
        .map((principal) => String(principal.id));
    },
    5 * 60_000,
  );
}

/**
 * Who hears about something in this scope.
 *
 * The author is excluded throughout. Nobody needs an email telling them what they
 * just did, and sending one is the single fastest way to make people distrust the
 * rest of the notifications.
 */
async function audienceFor(
  projectId: string | null,
  exclude: string,
): Promise<string[]> {
  const ids = projectId ? await projectMembers(projectId) : await everyone();
  const audience = ids.filter((id) => id !== exclude);

  if (audience.length > MAX_RECIPIENTS) {
    appLog.warn(
      { projectId, wanted: audience.length, cap: MAX_RECIPIENTS },
      'Collaboration notification audience capped',
    );
    return audience.slice(0, MAX_RECIPIENTS);
  }

  return audience;
}

interface Announcement {
  /** The email switch this is governed by. */
  gate: keyof UserPreferences['email'];
  title: string;
  body: string;
  /** An EPM route. Made absolute for the email, never an OpenProject URL. */
  link: string;
  /** Unique per event, so a redelivery or a double-save sends one email. */
  dedupeKey: string;
}

/**
 * Sends one announcement to a scope.
 *
 * On the digest channel, not immediate: none of these is urgent enough to
 * interrupt somebody, and one summary a day is what the switches promise. The
 * exception is a meeting invitation, which names a time the recipient has to be
 * somewhere — that one asks for `immediate` explicitly.
 */
async function announce(
  projectId: string | null,
  actorId: string,
  announcement: Announcement,
  channel: 'immediate' | 'digest' = 'digest',
): Promise<void> {
  try {
    const audience = await audienceFor(projectId, actorId);

    // Sequential rather than parallel. Each enqueue reads the recipient's
    // preferences and address, both cached, and a hundred concurrent writes to
    // one table for a background side effect is not worth the milliseconds.
    for (const recipientId of audience) {
      const recipient = await resolveRecipient(recipientId).catch(() => undefined);
      if (!recipient) continue;

      await enqueueEmail({
        recipientId,
        template: 'notification',
        payload: {
          firstName: recipient.firstName,
          title: announcement.title,
          body: announcement.body,
          url: `${env.APP_BASE_URL}${announcement.link}`,
        },
        channel,
        dedupeKey: `${announcement.dedupeKey}:${recipientId}`,
        gate: announcement.gate,
      });
    }
  } catch (error) {
    // Logged, never propagated: the thing this describes has already happened.
    appLog.warn({ err: error }, 'Collaboration notification could not be sent');
  }
}

/* -------------------------------------------------------------------------- */
/* Producers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A published announcement.
 *
 * Only on publication, and only once: `publishedAt` is keyed into the dedupe key,
 * so editing a published post sends nothing and unpublishing then republishing
 * sends again — which is the behaviour the two actions describe.
 */
export async function notifyNewsPublished(post: {
  id: string;
  title: string;
  summary: string | null;
  projectId: string | null;
  authorId: string;
  publishedAt: Date;
}): Promise<void> {
  await announce(post.projectId, post.authorId, {
    gate: 'news',
    title: post.title,
    body: post.summary ?? 'A new announcement has been published.',
    link: `/news`,
    dedupeKey: `news:${post.id}:${post.publishedAt.toISOString()}`,
  });
}

/**
 * A meeting somebody has been invited to.
 *
 * Goes to the participants, not to the project: a meeting invitation is addressed
 * to the people expected in the room. Sent immediately rather than in the digest,
 * because it names a time somebody has to be somewhere and a summary tomorrow
 * morning may be too late.
 */
export async function notifyMeetingInvited(
  meeting: { id: string; title: string; startsAt: Date; projectId: string | null },
  participantIds: string[],
  actorId: string,
): Promise<void> {
  try {
    for (const recipientId of participantIds.filter((id) => id !== actorId)) {
      const recipient = await resolveRecipient(recipientId).catch(() => undefined);
      if (!recipient) continue;

      await enqueueEmail({
        recipientId,
        template: 'notification',
        payload: {
          firstName: recipient.firstName,
          title: `Meeting: ${meeting.title}`,
          // The instant, written in UTC and labelled as such. The recipient's own
          // zone is not knowable here for everybody, and an unlabelled time is
          // worse than a labelled one in the wrong zone.
          body: `${meeting.startsAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`,
          url: `${env.APP_BASE_URL}/meetings/${meeting.id}`,
        },
        channel: 'immediate',
        // Keyed on the start time, so moving a meeting notifies again and saving
        // the agenda does not.
        dedupeKey: `meeting:${meeting.id}:${meeting.startsAt.toISOString()}:${recipientId}`,
        gate: 'meetings',
      });
    }
  } catch (error) {
    appLog.warn({ err: error }, 'Meeting invitation could not be sent');
  }
}

/**
 * A wiki page created or edited.
 *
 * Default off in the preferences, and deliberately: a busy wiki produces a lot of
 * small edits, and a stream of "somebody fixed a typo" is how people learn to
 * ignore EPM's email. The switch exists for teams who want it.
 */
export async function notifyWikiChanged(page: {
  id: string;
  slug: string;
  title: string;
  projectId: string | null;
  updatedBy: string;
  /** Distinguishes a new page from an edit, and keys the dedupe. */
  updatedAt: Date;
  created: boolean;
}): Promise<void> {
  const query = page.projectId ? `?projectId=${page.projectId}` : '';

  await announce(page.projectId, page.updatedBy, {
    gate: 'wiki',
    title: page.created ? `New wiki page: ${page.title}` : `Wiki page updated: ${page.title}`,
    body: page.created
      ? 'A page has been added to the wiki.'
      : 'A page you can see has been edited.',
    link: `/wiki/${page.slug}${query}`,
    dedupeKey: `wiki:${page.id}:${page.updatedAt.toISOString()}`,
  });
}

/** A file uploaded to a project. Default off, for the same reason the wiki is. */
export async function notifyDocumentUploaded(document: {
  id: string;
  name: string;
  projectId: string | null;
  uploadedBy: string;
}): Promise<void> {
  await announce(document.projectId, document.uploadedBy, {
    gate: 'documents',
    title: `New document: ${document.name}`,
    body: 'A file has been uploaded to a project you can see.',
    link: document.projectId ? `/projects/${document.projectId}/documents` : '/documents',
    dedupeKey: `document:${document.id}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Comments                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Who is involved in a work package.
 *
 * Its assignee, whoever it is accountable to, its author and its watchers — the
 * people a comment on it concerns. Read as the service, because the commenter may
 * not be permitted to list watchers even where they can comment.
 *
 * Failure yields an empty audience rather than throwing. Nobody hearing about a
 * comment is a worse outcome than the comment failing to save, which is why this
 * is never on the write path.
 */
async function involvedIn(workPackageId: string): Promise<{
  people: string[];
  subject: string;
  projectId: string | null;
}> {
  const workPackage = await asService(() =>
    openProject.request<OpWorkPackage>(`/work_packages/${workPackageId}`),
  ).catch(() => null);

  if (!workPackage) return { people: [], subject: `#${workPackageId}`, projectId: null };

  const links = workPackage._links ?? {};
  const direct = ['assignee', 'responsible', 'author']
    .map((rel) => linkId(links, rel))
    .filter((id): id is string => Boolean(id));

  const watchers = await asService(() =>
    openProject.getAll<OpPrincipal>(`/work_packages/${workPackageId}/watchers`, { pageSize: 100 }, {}),
  ).catch(() => ({ items: [] as OpPrincipal[] }));

  return {
    people: [...new Set([...direct, ...watchers.items.map((watcher) => String(watcher.id))])],
    subject: workPackage.subject ?? `#${workPackageId}`,
    projectId: linkId(links, 'project') ?? null,
  };
}

/**
 * The people a comment names, from OpenProject's own mention markup.
 *
 * Comments are written and stored as markdown, and a mention inserted by the
 * editor survives in it as an HTML `<mention>` element carrying the user id — so
 * this reads the id rather than trying to match a display name, which would be
 * ambiguous the moment two people share a first name.
 *
 * A plain `@name` typed by hand is deliberately not matched. There is no reliable
 * way to resolve it to one person, and mailing the wrong colleague is worse than
 * mailing nobody; the editor's own mention is the supported form.
 */
export function mentionedIn(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(/<mention[^>]*\sdata-id="(\d+)"/g)) {
    ids.add(match[1]!);
  }
  return [...ids];
}

/**
 * A comment added to a work package.
 *
 * Two audiences and two gates, which is why this is one function rather than two:
 * whoever was mentioned hears about it under `mentions`, and everybody else
 * involved hears about it under `comments`. A person who is both only gets the
 * mention — being named is the stronger signal, and two emails about one comment
 * is how people learn to filter the lot.
 *
 * Mentions are sent immediately: somebody has addressed this person directly. The
 * rest goes in the digest.
 */
export async function notifyCommentAdded(input: {
  workPackageId: string;
  commentId: string;
  body: string;
  authorId: string;
  authorName: string;
}): Promise<void> {
  try {
    const { people, subject, projectId } = await involvedIn(input.workPackageId);
    const mentioned = new Set(mentionedIn(input.body).filter((id) => id !== input.authorId));

    // Trimmed, because a comment can be pages long and an email preview is a
    // line. The link is what opens the whole thing.
    const excerpt = input.body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
    const url = `${env.APP_BASE_URL}/tasks/${input.workPackageId}`;

    const send = async (
      recipientId: string,
      gate: 'mentions' | 'comments',
      channel: 'immediate' | 'digest',
    ) => {
      const recipient = await resolveRecipient(recipientId).catch(() => undefined);
      if (!recipient) return;

      await enqueueEmail({
        recipientId,
        template: 'notification',
        payload: {
          firstName: recipient.firstName,
          title:
            gate === 'mentions'
              ? `${input.authorName} mentioned you on ${subject}`
              : `${input.authorName} commented on ${subject}`,
          body: excerpt,
          url,
        },
        channel,
        // Keyed on the comment, so an edit to it does not mail the thread again.
        dedupeKey: `comment:${input.commentId}:${recipientId}`,
        gate,
      });
    };

    for (const recipientId of mentioned) {
      await send(recipientId, 'mentions', 'immediate');
    }

    for (const recipientId of people) {
      if (recipientId === input.authorId || mentioned.has(recipientId)) continue;
      await send(recipientId, 'comments', 'digest');
    }

    void projectId;
  } catch (error) {
    appLog.warn({ err: error }, 'Comment notification could not be sent');
  }
}
