/**
 * Authorisation checks for the surfaces the main suite had none for: meetings,
 * news, the wiki, documents, logged time, the assistant, the OpenProject
 * webhook receiver, sessions, invitations and preferences.
 *
 * Run from authz-test.ts with the suite's own helpers and sessions (see
 * `SurfaceContext`), so it drives the API the way the rest of the suite does —
 * as the administrator, as the account with no project role, and as nobody —
 * and every deny case calls the API directly rather than through the UI.
 *
 * What each section holds the API to is BRL-01: nobody sees or changes data
 * beyond their permissions, through any path. So the cases are mostly
 * cross-project (the restricted account against the suite's private project)
 * and cross-user (one person's records against another's), each beside the
 * positive case that shows the refusal is a rule and not a broken route.
 *
 * Everything made here is registered for removal the moment it exists, so a
 * run stopped part-way still takes it away; most of it is also removed in line,
 * as the positive case for deletion. And nothing here can email anybody: no
 * invitation is made, no meeting has a participant, nothing is announced to a
 * project unless the administrator is the only one in it, and nothing is ever
 * sent to the assistant's model.
 */

import { createHmac, randomBytes } from 'node:crypto';

import type { Prisma } from '@prisma/client';

/** The options the suite's `call` takes. */
type CallOptions = { method?: string; cookie?: string; body?: unknown };

/** What the main suite hands over: its own helpers and sessions, unchanged. */
export interface SurfaceContext {
  /** The suite's `call`: one request to the API, with a JSON body when given. */
  call: (path: string, options?: CallOptions) => Promise<Response>;
  /** The suite's `status`: the same request, answering only its status code. */
  status: (path: string, options?: CallOptions) => Promise<number>;
  /** The suite's `check`: one assertion, counted and printed. */
  check: (name: string, actual: unknown, expected: unknown) => void;
  /** Session cookies, as the suite's `signIn` returns them. */
  admin: string;
  restricted: string;
  adminId: string;
  restrictedId: string;
  /** The suite's private project: the administrator's, and the restricted account is no member of it. */
  projectId: string;
  /**
   * The API root the suite calls (`BASE`), for the two requests `call` cannot
   * make: a multipart upload, and a webhook delivery with a signature header.
   */
  base: string;
  /**
   * A fresh session for the restricted account: `() => signIn(RESTRICTED)`. The
   * session checks end a session, so they end one of their own rather than one
   * the rest of the run depends on.
   */
  signInRestricted: () => Promise<string>;
  /** Registers a removal, run in the suite's cleanup however far the run got. */
  cleanup: { onCleanup(fn: () => Promise<void>): void };
}

export async function surfaceChecks(ctx: SurfaceContext): Promise<void> {
  const { call, status, check, admin, restricted, adminId, restrictedId, projectId, base, cleanup } = ctx;
  const { prisma } = await import('../db/prisma.js');

  const stamp = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  // Meetings are set in the past, so none ever sits in anybody's upcoming list
  // for the moment it exists.
  const longAgo = '2000-01-03T09:00:00.000Z';

  /** A response body, or an empty object when there is none to read. */
  const json = async <T>(response: Response): Promise<T> => (await response.json().catch(() => ({}))) as T;

  /**
   * Whether a list holds a record — or, when the list itself was refused, the
   * status, so a failure says which it was. Takes a bare array or a page.
   */
  const lists = async (path: string, cookie: string, id: string): Promise<boolean | number> => {
    const response = await call(path, { cookie });
    if (!response.ok) return response.status;
    const body = await json<{ id?: string }[] | { items?: { id?: string }[] }>(response);
    return (Array.isArray(body) ? body : (body.items ?? [])).some((row) => row.id === id);
  };

  /**
   * For the statuses OpenProject decides rather than EPM. Logged time is
   * authorised upstream (time-entries.ts:36-53) and EPM passes the refusal on
   * as 403 or 404 (time-entries.ts:158-167); which one depends on the
   * endpoint upstream. Either is a refusal, and anything else is reported as
   * the number it was.
   */
  const refusal = (code: number): number | 'refused' => (code === 403 || code === 404 ? 'refused' : code);

  /**
   * Removes an EPM-owned record however far the run got: through the API as
   * whoever made it, and from its table when that did not work — a record a
   * broken rule let move out of its author's reach is still this run's.
   */
  const removeRecord = (path: string, cookie: string, drop: () => Promise<unknown>) => async () => {
    const response = await call(path, { method: 'DELETE', cookie }).catch(() => undefined);
    if (response?.status !== 204) await drop().catch(() => undefined);
  };

  // --- Before the surfaces -------------------------------------------------
  // The main suite lends the restricted account a role on the private project
  // and takes it back. Permissions are cached for a minute (capabilities.ts:74),
  // so a role that ended moments ago could still be answering for them below.
  // Any successful write drops the caller's cached permissions and the
  // per-person project lists (app.ts:265, 272), so they make one that changes
  // nothing: marking no notifications read.
  await call('/notifications/read', { method: 'PATCH', cookie: restricted, body: { ids: [] } });

  // A wiki page, a published post and a filed document are announced to the
  // project's members other than their author (collaboration-notifications.ts:
  // 126-142). With nobody in the project but the administrator there is nobody
  // to tell, so those are made only then. It is also what every "restricted
  // cannot" below rests on.
  const membersResponse = await call(`/projects/${projectId}/members`, { cookie: admin });
  const members = membersResponse.ok ? await json<{ userId: string }[]>(membersResponse) : undefined;
  const quiet = Array.isArray(members) && members.every((member) => member.userId === adminId);
  check('nobody but the administrator belongs to the private project', quiet, true);

  // A project the restricted account can see, for the "move it somewhere they
  // cannot" cases: a record made where they may, then pointed at the private
  // project.
  const theirMe = await json<{ projectPermissions?: Record<string, { project?: { view?: boolean } }> }>(
    await call('/me', { cookie: restricted }),
  );
  const theirProject = Object.entries(theirMe.projectPermissions ?? {}).find(
    ([id, set]) => id !== projectId && set.project?.view === true,
  )?.[0];

  // --- Meetings ------------------------------------------------------------
  // EPM's own rows. Seeing a project's meetings needs project:view there, and
  // so does adding one; changing one needs authorship or project:edit
  // (collaboration.ts:21-41). A meeting the caller cannot see is reported as
  // absent rather than forbidden, so a refusal confirms nothing (meetings.ts:
  // 124-140); naming the project outright is refused, since its existence is
  // not news to the caller (meetings.ts:149-151).
  console.log('\nMeetings');

  interface TestMeeting {
    id: string;
    title: string;
    projectId?: string;
  }

  check('anonymous cannot list meetings', await status('/meetings'), 401);

  // No participants, so the invitation a meeting sends goes to nobody
  // (meetings.ts:229-245, collaboration-notifications.ts:241).
  const meetingTitle = `Authz surfaces meeting ${stamp}`;
  const meetingResponse = await call('/meetings', {
    method: 'POST',
    cookie: admin,
    body: { title: meetingTitle, projectId, startsAt: longAgo, durationMinutes: 30, participantIds: [] },
  });
  check('admin can schedule a meeting in the private project', meetingResponse.status, 201);
  const meeting = meetingResponse.status === 201 ? await json<TestMeeting>(meetingResponse) : undefined;

  if (meeting?.id) {
    const meetingId = meeting.id;
    cleanup.onCleanup(
      removeRecord(`/meetings/${meetingId}`, admin, () => prisma.meeting.deleteMany({ where: { id: meetingId } })),
    );

    check(
      'the administrator finds it among the project’s meetings',
      await lists(`/meetings?projectId=${projectId}&window=all&pageSize=200`, admin, meetingId),
      true,
    );
    check('restricted cannot open it', await status(`/meetings/${meetingId}`, { cookie: restricted }), 404);
    // Unfiltered, the list is scoped in the query to the projects they can see.
    check(
      'nor find it among every meeting they may see',
      await lists('/meetings?window=all&pageSize=200', restricted, meetingId),
      false,
    );
    check(
      'restricted cannot change it',
      await status(`/meetings/${meetingId}`, { method: 'PATCH', cookie: restricted, body: { title: 'Taken over' } }),
      404,
    );
    check(
      'nor record who attended it',
      await status(`/meetings/${meetingId}/attendance`, {
        method: 'PATCH',
        cookie: restricted,
        body: { attended: [restrictedId] },
      }),
      404,
    );
    check('nor delete it', await status(`/meetings/${meetingId}`, { method: 'DELETE', cookie: restricted }), 404);
    check(
      'and it is as the administrator left it',
      (await json<TestMeeting>(await call(`/meetings/${meetingId}`, { cookie: admin }))).title,
      meetingTitle,
    );
    check('the administrator can delete it', await status(`/meetings/${meetingId}`, { method: 'DELETE', cookie: admin }), 204);
  }

  check(
    'restricted cannot list the private project’s meetings',
    await status(`/meetings?projectId=${projectId}`, { cookie: restricted }),
    403,
  );
  const intrudingMeeting = await call('/meetings', {
    method: 'POST',
    cookie: restricted,
    body: { title: `Authz surfaces intrusion ${stamp}`, projectId, startsAt: longAgo, durationMinutes: 30, participantIds: [] },
  });
  check('restricted cannot schedule a meeting there', intrudingMeeting.status, 403);
  if (intrudingMeeting.status === 201) {
    const strayId = (await json<TestMeeting>(intrudingMeeting)).id;
    if (strayId) {
      cleanup.onCleanup(
        removeRecord(`/meetings/${strayId}`, admin, () => prisma.meeting.deleteMany({ where: { id: strayId } })),
      );
    }
  }

  if (theirProject) {
    const ownResponse = await call('/meetings', {
      method: 'POST',
      cookie: restricted,
      body: {
        title: `Authz surfaces own meeting ${stamp}`,
        projectId: theirProject,
        startsAt: longAgo,
        durationMinutes: 30,
        participantIds: [],
      },
    });
    check('restricted can schedule a meeting in a project they can see', ownResponse.status, 201);
    const ownId = ownResponse.status === 201 ? (await json<TestMeeting>(ownResponse)).id : undefined;
    if (ownId) {
      cleanup.onCleanup(
        removeRecord(`/meetings/${ownId}`, restricted, () => prisma.meeting.deleteMany({ where: { id: ownId } })),
      );
      // Their own, so authorship lets them edit it. Moving it is a new scope,
      // authorised against the destination as well (meetings.ts:264-272).
      check(
        'but cannot move it into the private project',
        await status(`/meetings/${ownId}`, { method: 'PATCH', cookie: restricted, body: { projectId } }),
        403,
      );
      check(
        'which leaves it where it was',
        (await json<TestMeeting>(await call(`/meetings/${ownId}`, { cookie: restricted }))).projectId,
        theirProject,
      );
      // Out of a real project at once; the cleanup is only the net.
      await call(`/meetings/${ownId}`, { method: 'DELETE', cookie: restricted }).catch(() => undefined);
    }
  } else {
    console.log('  SKIP  restricted can see no project of its own to move a meeting out of');
  }

  // --- News ----------------------------------------------------------------
  // The same scope rules as meetings, with one more: a draft is its author's
  // alone until it is published, and is absent to everybody else (news.ts:
  // 95-99). Every post the restricted account tries to make is a draft too, so
  // not even a broken rule could announce it to anybody (news.ts:194-202).
  console.log('\nNews');

  interface TestPost {
    id: string;
    title: string;
  }

  check('anonymous cannot read the news', await status('/news'), 401);

  const postTitle = `Authz surfaces post ${stamp}`;
  const postResponse = await call('/news', {
    method: 'POST',
    cookie: admin,
    body: { title: postTitle, projectId, body: 'An authorisation probe, removed by the suite.', published: false },
  });
  check('admin can save a draft post in the private project', postResponse.status, 201);
  const post = postResponse.status === 201 ? await json<TestPost>(postResponse) : undefined;

  if (post?.id) {
    const postId = post.id;
    cleanup.onCleanup(removeRecord(`/news/${postId}`, admin, () => prisma.newsPost.deleteMany({ where: { id: postId } })));

    check('restricted cannot read somebody else’s draft', await status(`/news/${postId}`, { cookie: restricted }), 404);

    if (quiet) {
      // Published only now the project is known to hold nobody to tell: the
      // announcement goes to its members other than the author.
      check(
        'admin can publish it',
        await status(`/news/${postId}`, { method: 'PATCH', cookie: admin, body: { published: true } }),
        200,
      );
      check(
        'the administrator finds it in the project’s news',
        await lists(`/news?projectId=${projectId}&pageSize=200`, admin, postId),
        true,
      );
      // Published, so it is now the project that keeps it from them.
      check('restricted still cannot read it', await status(`/news/${postId}`, { cookie: restricted }), 404);
      check(
        'nor find it in their news, drafts and all',
        await lists('/news?includeDrafts=true&pageSize=200', restricted, postId),
        false,
      );
    } else {
      console.log('  SKIP  the post stays a draft: someone besides the administrator would be told it was published');
    }

    check(
      'restricted cannot edit it',
      await status(`/news/${postId}`, { method: 'PATCH', cookie: restricted, body: { title: 'Taken over' } }),
      404,
    );
    check('nor delete it', await status(`/news/${postId}`, { method: 'DELETE', cookie: restricted }), 404);
    check(
      'and it is as the administrator left it',
      (await json<TestPost>(await call(`/news/${postId}`, { cookie: admin }))).title,
      postTitle,
    );
    check('the administrator can delete it', await status(`/news/${postId}`, { method: 'DELETE', cookie: admin }), 204);
  }

  check(
    'restricted cannot list the private project’s news',
    await status(`/news?projectId=${projectId}`, { cookie: restricted }),
    403,
  );
  const removeStrayPost = async (response: Response) => {
    if (response.status !== 201) return;
    const strayId = (await json<TestPost>(response)).id;
    if (strayId) {
      cleanup.onCleanup(removeRecord(`/news/${strayId}`, restricted, () => prisma.newsPost.deleteMany({ where: { id: strayId } })));
    }
  };
  const intrudingPost = await call('/news', {
    method: 'POST',
    cookie: restricted,
    body: { title: `Authz surfaces intrusion ${stamp}`, projectId, body: 'Should not exist.', published: false },
  });
  check('restricted cannot post in the private project', intrudingPost.status, 403);
  await removeStrayPost(intrudingPost);
  // Organisation-wide is addressed to everybody, so it is an administrator's to
  // publish (collaboration.ts:38-40, 76-78).
  const announcement = await call('/news', {
    method: 'POST',
    cookie: restricted,
    body: { title: `Authz surfaces announcement ${stamp}`, body: 'Should not exist.', published: false },
  });
  check('nor post to the whole organisation', announcement.status, 403);
  await removeStrayPost(announcement);

  if (theirProject) {
    const ownResponse = await call('/news', {
      method: 'POST',
      cookie: restricted,
      body: {
        title: `Authz surfaces own post ${stamp}`,
        projectId: theirProject,
        body: 'An authorisation probe, removed by the suite.',
        published: false,
      },
    });
    check('restricted can draft a post in a project they can see', ownResponse.status, 201);
    const ownId = ownResponse.status === 201 ? (await json<TestPost>(ownResponse)).id : undefined;
    if (ownId) {
      cleanup.onCleanup(removeRecord(`/news/${ownId}`, restricted, () => prisma.newsPost.deleteMany({ where: { id: ownId } })));
      check(
        'but cannot move it into the private project',
        await status(`/news/${ownId}`, { method: 'PATCH', cookie: restricted, body: { projectId } }),
        403,
      );
      await call(`/news/${ownId}`, { method: 'DELETE', cookie: restricted }).catch(() => undefined);
    }
  } else {
    console.log('  SKIP  restricted can see no project of its own to move a post out of');
  }

  // --- Wiki ----------------------------------------------------------------
  // The same scope rules again. A page asked for by its address names its
  // project, so a refusal there is a refusal (wiki.ts:232-238); asked for by
  // id it is absent (wiki.ts:120-133), and that is checked before anything
  // else on every route that takes one.
  console.log('\nWiki');

  interface TestPage {
    id: string;
    slug: string;
    body: string;
  }

  check('anonymous cannot read the wiki', await status('/wiki/tree'), 401);
  check(
    'restricted cannot read the private project’s wiki',
    await status(`/wiki/tree?projectId=${projectId}`, { cookie: restricted }),
    403,
  );

  // Writing or editing a page is announced to the project's members other than
  // the writer (wiki.ts:323, 411) — including the attempt below, were the rule
  // that refuses it ever to break. So only while nobody else is in it.
  if (quiet) {
    const pageResponse = await call('/wiki/pages', {
      method: 'POST',
      cookie: admin,
      body: { title: `Authz surfaces page ${stamp}`, body: 'First version.', projectId },
    });
    check('admin can write a page in the private project', pageResponse.status, 201);
    const page = pageResponse.status === 201 ? await json<TestPage>(pageResponse) : undefined;

    if (page?.id) {
      const pageId = page.id;
      cleanup.onCleanup(
        removeRecord(`/wiki/pages/${pageId}`, admin, () => prisma.wikiPage.deleteMany({ where: { id: pageId } })),
      );

      // An edit, so the page has a past version to ask for and to restore.
      check(
        'and edit it, which keeps the first version',
        await status(`/wiki/pages/${pageId}`, { method: 'PATCH', cookie: admin, body: { body: 'Second version.' } }),
        200,
      );
      const revisions = await json<{ id: string }[]>(await call(`/wiki/pages/${pageId}/revisions`, { cookie: admin }));
      const revisionId = (Array.isArray(revisions) ? revisions[0]?.id : undefined) ?? 'none';

      check(
        'restricted cannot open it by its address',
        await status(`/wiki/page?slug=${encodeURIComponent(page.slug)}&projectId=${projectId}`, { cookie: restricted }),
        403,
      );
      check('nor by its id', await status(`/wiki/pages/${pageId}`, { cookie: restricted }), 404);
      check('nor read its history', await status(`/wiki/pages/${pageId}/revisions`, { cookie: restricted }), 404);
      check(
        'restricted cannot edit it',
        await status(`/wiki/pages/${pageId}`, { method: 'PATCH', cookie: restricted, body: { body: 'Taken over.' } }),
        404,
      );
      check(
        'nor restore its first version',
        await status(`/wiki/pages/${pageId}/revisions/${revisionId}/restore`, { method: 'POST', cookie: restricted }),
        404,
      );
      check('nor delete it', await status(`/wiki/pages/${pageId}`, { method: 'DELETE', cookie: restricted }), 404);
      check(
        'and it reads as the administrator left it',
        (await json<TestPage>(await call(`/wiki/pages/${pageId}`, { cookie: admin }))).body,
        'Second version.',
      );
      check('the administrator can delete it', await status(`/wiki/pages/${pageId}`, { method: 'DELETE', cookie: admin }), 204);
    }

    const intrudingPage = await call('/wiki/pages', {
      method: 'POST',
      cookie: restricted,
      body: { title: `Authz surfaces intrusion ${stamp}`, body: 'Should not exist.', projectId },
    });
    check('restricted cannot write a page in the private project', intrudingPage.status, 403);
    if (intrudingPage.status === 201) {
      const strayId = (await json<TestPage>(intrudingPage)).id;
      if (strayId) {
        cleanup.onCleanup(
          removeRecord(`/wiki/pages/${strayId}`, admin, () => prisma.wikiPage.deleteMany({ where: { id: strayId } })),
        );
      }
    }
  } else {
    console.log('  SKIP  no page is written: the project has members besides the administrator, who would be told');
  }

  // --- Documents -----------------------------------------------------------
  // OpenProject attachments indexed by EPM's own rows. The library is asked of
  // OpenProject per file with the caller's own token and keeps only what they
  // can read (documents.ts:94-102); a download or a deletion of a file they
  // cannot read is absent (documents.ts:262-270, 310-317).
  console.log('\nDocuments');

  interface TestDocument {
    id: string;
  }

  /** Multipart, built as the library builds it: the fields before the file. */
  const fileDocument = (cookie: string, name: string) => {
    const form = new FormData();
    form.append('projectId', projectId);
    form.append('file', new Blob(['An authorisation probe, removed by the suite.\n'], { type: 'text/plain' }), name);
    return fetch(`${base}/documents`, { method: 'POST', headers: { cookie }, body: form });
  };

  check('anonymous cannot list documents', await status('/documents'), 401);

  // Filing a document announces it to the project's members other than the
  // uploader (documents.ts:232-239), so, as with the wiki, only while nobody
  // else is in it.
  if (quiet) {
    const filed = await fileDocument(admin, `authz-surfaces-${stamp}.txt`);
    check('admin can file a document under the private project', filed.status, 201);
    const documentId = filed.status === 201 ? (await json<TestDocument>(filed)).id : undefined;

    if (documentId) {
      cleanup.onCleanup(async () => {
        await call(`/documents/${documentId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
      });

      check(
        'the administrator finds it in the project’s library',
        await lists(`/documents?projectId=${projectId}`, admin, documentId),
        true,
      );
      check(
        'restricted does not, asking for that project by name',
        await lists(`/documents?projectId=${projectId}`, restricted, documentId),
        false,
      );
      check('restricted cannot download it', await status(`/documents/${documentId}/content`, { cookie: restricted }), 404);
      check('nor delete it', await status(`/documents/${documentId}`, { method: 'DELETE', cookie: restricted }), 404);
      const download = await call(`/documents/${documentId}/content`, { cookie: admin });
      await download.arrayBuffer().catch(() => undefined);
      check('and it is still there for the administrator', download.status, 200);
      check('who can remove it', await status(`/documents/${documentId}`, { method: 'DELETE', cookie: admin }), 204);
    }

    // An upload is a container-less attachment and the project is only EPM's
    // label for it, so OpenProject never sees the project (documents.ts). EPM
    // checks it before OpenProject is asked anything, and the message says
    // whose refusal it was: OpenProject's, for an account it lets upload
    // nowhere, would have been a 403 as well, and proved nothing.
    const intrudingDocument = await fileDocument(restricted, `authz-surfaces-intrusion-${stamp}.txt`);
    const intrusion = await json<{ id?: string; message?: string }>(intrudingDocument);
    check('restricted cannot file a document under the private project', intrudingDocument.status, 403);
    check(
      'and it is the project that refuses it, in EPM',
      intrusion.message?.startsWith('You do not have permission to') ?? false,
      true,
    );
    if (intrudingDocument.status === 201) {
      const strayId = intrusion.id;
      if (strayId) {
        cleanup.onCleanup(async () => {
          await call(`/documents/${strayId}`, { method: 'DELETE', cookie: restricted }).catch(() => undefined);
          await call(`/documents/${strayId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
        });
      }
    }
  } else {
    console.log('  SKIP  no document is filed: the project has members besides the administrator, who would be told');
  }

  // --- Time entries --------------------------------------------------------
  // Authorised by OpenProject, not EPM: every route forwards the caller's own
  // token and passes the refusal on (time-entries.ts:36-53, 158-167). So the
  // statuses that are upstream's to choose are asserted as refusals, and the
  // lists are checked for what they hold rather than for how they refused.
  console.log('\nTime entries');

  interface TestTimeEntry {
    id: string;
    hours: number;
    projectId: string;
    userId: string;
  }

  interface TestReport {
    rows?: { key: string; hours: number }[];
  }

  check('anonymous cannot read logged time', await status('/time-entries'), 401);

  // Logged the way the main suite logs it: an instance that insists on an
  // activity names one in the project's form.
  let activityId: string | undefined;
  // From OpenProject 17 time belongs to a work package: a task to log it on.
  const timeTask = (await json<{ id?: string }>(await call('/tasks', { method: 'POST', cookie: admin, body: { projectId, subject: 'Authz surfaces probe time' } }))).id;
  const logTime = (cookie: string) =>
    call('/time-entries', {
      method: 'POST',
      cookie,
      body: { projectId, workPackageId: timeTask, hours: 1, spentOn: today, comment: 'Authz surfaces probe', ...(activityId ? { activityId } : {}) },
    });
  let logged = await logTime(admin);
  if (logged.status !== 201) {
    const form = JSON.stringify(
      await json(await call('/forms/time-entries', { method: 'POST', cookie: admin, body: { projectId, workPackageId: timeTask } })),
    );
    activityId = /time_entries\/activities\/(\d+)/.exec(form)?.[1];
    logged = await logTime(admin);
  }
  check('admin can log time on the private project', logged.status, 201);
  const entryId = logged.status === 201 ? (await json<TestTimeEntry>(logged)).id : undefined;
  const range = `from=${today}&to=${today}`;

  if (entryId) {
    cleanup.onCleanup(async () => {
      await call(`/time-entries/${entryId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
    });

    check('the administrator can read it', await status(`/time-entries/${entryId}`, { cookie: admin }), 200);
    check('restricted cannot read it', refusal(await status(`/time-entries/${entryId}`, { cookie: restricted })), 'refused');
    // Read first with the caller's token, so a refusal comes before any write
    // (time-entries.ts:566-569, 589-590).
    check(
      'nor change it',
      refusal(await status(`/time-entries/${entryId}`, { method: 'PATCH', cookie: restricted, body: { hours: 9 } })),
      'refused',
    );
    check(
      'nor delete it',
      refusal(await status(`/time-entries/${entryId}`, { method: 'DELETE', cookie: restricted })),
      'refused',
    );
    check(
      'and it is as it was logged',
      (await json<TestTimeEntry>(await call(`/time-entries/${entryId}`, { cookie: admin }))).hours,
      1,
    );

    check(
      'the administrator finds it in the project’s time',
      await lists(`/time-entries?projectId=${projectId}&${range}&pageSize=200`, admin, entryId),
      true,
    );
    // Unfiltered, OpenProject scopes the list to what they may see.
    check(
      'restricted’s own view of the day leaves it out',
      await lists(`/time-entries?${range}&pageSize=200`, restricted, entryId),
      false,
    );
    // Named outright, the project is OpenProject's to refuse or to answer with
    // nothing; either way none of its time may come back.
    const named = await call(`/time-entries?projectId=${projectId}&${range}&pageSize=200`, { cookie: restricted });
    const namedRows = named.ok ? ((await json<{ items?: TestTimeEntry[] }>(named)).items ?? []) : [];
    check('nor does naming the private project in the filter', namedRows.some((row) => row.projectId === projectId), false);

    // Time & Costs walks the entries on the caller's own token
    // (time-entries.ts:432-445), so its totals are of what they may see.
    const reportRow = async (cookie: string, filter = '') => {
      const response = await call(`/time-entries/report?${range}&groupBy=project${filter}`, { cookie });
      const report: TestReport = response.ok ? await json<TestReport>(response) : {};
      return { status: response.status, row: (report.rows ?? []).find((row) => row.key === projectId) };
    };
    check(
      'the Time & Costs report gives the administrator the project’s hours',
      ((await reportRow(admin)).row?.hours ?? 0) >= 1,
      true,
    );
    const theirReport = await reportRow(restricted);
    check('restricted can run the report', theirReport.status, 200);
    check('and it holds none of the private project’s hours', theirReport.row?.hours, undefined);
    check(
      'nor when filtered to the private project',
      (await reportRow(restricted, `&projectId=${projectId}`)).row?.hours,
      undefined,
    );

    check('the administrator can remove it', await status(`/time-entries/${entryId}`, { method: 'DELETE', cookie: admin }), 204);
  }

  const intrudingTime = await logTime(restricted);
  check('restricted cannot log time on the private project', refusal(intrudingTime.status), 'refused');
  if (intrudingTime.status === 201) {
    const strayId = (await json<TestTimeEntry>(intrudingTime)).id;
    if (strayId) {
      cleanup.onCleanup(async () => {
        await call(`/time-entries/${strayId}`, { method: 'DELETE', cookie: admin }).catch(() => undefined);
      });
    }
  }
  const projectTime = await json<{ items?: TestTimeEntry[] }>(
    await call(`/time-entries?projectId=${projectId}&${range}&pageSize=200`, { cookie: admin }),
  );
  check(
    'and nothing was logged there in their name',
    (projectTime.items ?? []).some((row) => row.userId === restrictedId),
    false,
  );

  // --- Assistant -----------------------------------------------------------
  // Conversations are their owner's: every read and every delete filters on
  // the caller, so another person's id is simply not found (assistant.ts:
  // 39-68). The one route that makes a conversation sends a prompt to the
  // model (assistant.ts:70-132) and nothing here may, so the administrator's
  // is written straight to its table.
  console.log('\nAssistant');

  check('anonymous cannot list conversations', await status('/assistant/conversations'), 401);

  const conversation = await prisma.assistantConversation
    .create({
      data: {
        userId: adminId,
        title: `Authz surfaces conversation ${stamp}`,
        messages: { create: [{ role: 'user', content: 'An authorisation probe; never sent to the model.' }] },
      },
      select: { id: true },
    })
    .catch(() => undefined);
  check('a conversation of the administrator’s exists to test against', Boolean(conversation), true);

  if (conversation) {
    const conversationId = conversation.id;
    cleanup.onCleanup(async () => {
      await prisma.assistantConversation.deleteMany({ where: { id: conversationId } }).catch(() => undefined);
    });

    check('the administrator sees it among theirs', await lists('/assistant/conversations', admin, conversationId), true);
    check('restricted does not see it among theirs', await lists('/assistant/conversations', restricted, conversationId), false);
    check('restricted cannot open it', await status(`/assistant/conversations/${conversationId}`, { cookie: restricted }), 404);
    check(
      'nor delete it',
      await status(`/assistant/conversations/${conversationId}`, { method: 'DELETE', cookie: restricted }),
      404,
    );
    check(
      'which leaves it in place for its owner',
      await status(`/assistant/conversations/${conversationId}`, { cookie: admin }),
      200,
    );
    check(
      'who can delete it',
      await status(`/assistant/conversations/${conversationId}`, { method: 'DELETE', cookie: admin }),
      204,
    );
  }

  // --- Webhook receiver ----------------------------------------------------
  // Public by design: OpenProject has no session, and proves a delivery with an
  // HMAC of the raw body instead (hook.ts:23-29, webhooks.ts:72-97). Every probe
  // carries an action nothing handles, so even a broken check would act on
  // nothing. A correctly signed delivery is the main suite's to send.
  console.log('\nWebhook receiver');

  const delivery = JSON.stringify({ action: 'authz:probe' });
  const deliver = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/webhooks/openproject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });

  // 503 instead would mean this deployment has no webhook secret (webhooks.ts:79-81).
  check('a delivery with no signature is refused', (await deliver(delivery)).status, 401);
  check(
    'a delivery with a wrong signature is refused',
    (await deliver(delivery, { 'X-OP-Signature': `sha1=${'0'.repeat(40)}` })).status,
    401,
  );
  // Lengths are compared before the constant-time comparison, which throws on
  // unequal lengths; this must be a refusal, not a 500 (webhooks.ts:91-95).
  check(
    'a malformed signature is refused, not an error',
    (await deliver(delivery, { 'X-OP-Signature': 'sha1=abc' })).status,
    401,
  );
  check(
    'a signed-in session is no substitute for the signature',
    (await deliver(delivery, { cookie: admin })).status,
    401,
  );
  const webhookSecret = process.env.OPENPROJECT_WEBHOOK_SECRET;
  if (webhookSecret) {
    // Signed, then changed in transit: the signature covers the bytes received.
    const signature = `sha1=${createHmac('sha1', webhookSecret).update(delivery).digest('hex')}`;
    check(
      'a delivery changed after it was signed is refused',
      (await deliver(JSON.stringify({ action: 'authz:probe', changed: true }), { 'X-OP-Signature': signature })).status,
      401,
    );
  } else {
    console.log('  SKIP  OPENPROJECT_WEBHOOK_SECRET is not set here, so a tampered delivery cannot be built');
  }

  // --- Sessions ------------------------------------------------------------
  // A person's own, always: the id comes from the session making the request
  // and every query filters on it, so someone else's session id matches
  // nothing (sessions.ts:17-19, 114-120). The session ended here is a fresh one
  // of the restricted account's, never one the run depends on.
  console.log('\nSessions');

  interface TestSession {
    id: string;
    current: boolean;
  }

  check('anonymous cannot list sessions', await status('/me/sessions'), 401);

  const throwaway = await ctx.signInRestricted().catch(() => undefined);
  check('a second session can be opened for the restricted account', Boolean(throwaway), true);

  if (throwaway) {
    cleanup.onCleanup(async () => {
      await call('/auth/logout', { method: 'POST', cookie: throwaway }).catch(() => undefined);
    });

    const sessionsOf = async (cookie: string) => {
      const rows = await json<TestSession[]>(await call('/me/sessions', { cookie }));
      return Array.isArray(rows) ? rows : [];
    };
    const throwawayId = (await sessionsOf(throwaway)).find((row) => row.current)?.id ?? 'none';
    const adminSessions = await sessionsOf(admin);
    const theirSessions = await sessionsOf(restricted);

    check('a person sees their other sessions', theirSessions.some((row) => row.id === throwawayId), true);
    check(
      'and none of anybody else’s',
      theirSessions.some((row) => adminSessions.some((own) => own.id === row.id)),
      false,
    );
    check('the administrator’s list does not show it', adminSessions.some((row) => row.id === throwawayId), false);
    // Even an administrator: there is no route to anybody else's sessions.
    check(
      'the administrator cannot end it',
      await status(`/me/sessions/${throwawayId}`, { method: 'DELETE', cookie: admin }),
      404,
    );
    check('which leaves it signed in', await status('/me', { cookie: throwaway }), 200);
    check(
      'its owner can end it from another session',
      await status(`/me/sessions/${throwawayId}`, { method: 'DELETE', cookie: restricted }),
      204,
    );
    check('after which it is signed out', await status('/me', { cookie: throwaway }), 401);
  }

  // --- Invitations ---------------------------------------------------------
  // Public by design: the token in the path is the credential (hook.ts:23-32,
  // invites.ts:15-28). Nothing is created here — only tokens that match
  // nothing are sent. The outbox an administrator reads beside them holds
  // every recipient's address, so it is the guarded route of the file.
  console.log('\nInvitations');

  // The shape real tokens have (invites.ts:32-33), from the same source, so it
  // reaches the lookup rather than stopping at the shape check.
  const unknownToken = randomBytes(32).toString('base64url');
  const malformed = await call('/invites/not-a-token');
  const unknown = await call(`/invites/${unknownToken}`);
  check('a malformed invitation token is not found', malformed.status, 404);
  check('nor is a well-formed one that matches nothing', unknown.status, 404);
  check(
    'and the two answers are indistinguishable',
    JSON.stringify(await json(malformed)) === JSON.stringify(await json(unknown)),
    true,
  );
  check(
    'a token that matches nothing cannot set a password',
    await status(`/invites/${unknownToken}/accept`, {
      method: 'POST',
      body: { password: 'Authz-probe-password-1!' },
    }),
    404,
  );
  check('anonymous cannot read the email outbox', await status('/admin/email/outbox?limit=1'), 401);
  check('restricted cannot read it', await status('/admin/email/outbox?limit=1', { cookie: restricted }), 403);
  check('an administrator can', await status('/admin/email/outbox?limit=1', { cookie: admin }), 200);

  // --- Preferences ---------------------------------------------------------
  // Always the caller's own: the id comes from the session, never the request,
  // so there is no way to name anybody else's (preferences.ts:6-14).
  console.log('\nPreferences');

  interface TestPreferences {
    appearance?: { compactTables?: boolean };
  }

  check('anonymous cannot read preferences', await status('/preferences'), 401);
  check('restricted can read their own', await status('/preferences', { cookie: restricted }), 200);
  // Unmatched, so the app's own 404 (app.ts:187-192).
  check('there is no address for anybody else’s', await status(`/preferences/${adminId}`, { cookie: restricted }), 404);
  check(
    'nor one to write them',
    await status(`/preferences/${adminId}`, { method: 'PUT', cookie: restricted, body: { appearance: { compactTables: true } } }),
    404,
  );

  // The restricted account's stored row, put back exactly at the end —
  // including "there was none" — as the main suite does for the administrator.
  const storedPreferences = await prisma.userPreference
    .findUnique({ where: { openProjectId: restrictedId }, select: { data: true } })
    .catch(() => undefined);

  if (storedPreferences !== undefined) {
    cleanup.onCleanup(async () => {
      const data = storedPreferences?.data as Prisma.InputJsonValue | undefined;
      await (data !== undefined
        ? prisma.userPreference.upsert({
            where: { openProjectId: restrictedId },
            create: { openProjectId: restrictedId, data },
            update: { data },
          })
        : prisma.userPreference.deleteMany({ where: { openProjectId: restrictedId } })
      ).catch(() => undefined);
    });

    const preferencesOf = async (cookie: string, query = '') =>
      json<TestPreferences>(await call(`/preferences${query}`, { cookie }));
    const adminCompact = (await preferencesOf(admin)).appearance?.compactTables;
    // The opposite of the administrator's, so it is clear whose a read returns.
    // A display switch and never email: were this ever to land on the
    // administrator, it must not switch their mail back on in the middle of a run.
    const flipped = adminCompact !== true;

    // Unknown keys are dropped by the schema (preferences.ts:27-29), and the
    // row written is the session's (preferences.ts:24, 31).
    check(
      'a write that names the administrator is taken as restricted’s own',
      await status('/preferences', {
        method: 'PUT',
        cookie: restricted,
        body: { userId: adminId, openProjectId: adminId, appearance: { compactTables: flipped } },
      }),
      200,
    );
    check('the administrator’s preferences are untouched', (await preferencesOf(admin)).appearance?.compactTables, adminCompact);
    check('the write landed on restricted’s own', (await preferencesOf(restricted)).appearance?.compactTables, flipped);
    check(
      'and naming the administrator in the query still reads restricted’s own',
      (await preferencesOf(restricted, `?userId=${adminId}`)).appearance?.compactTables,
      flipped,
    );
  } else {
    console.log("  SKIP  restricted's stored preferences could not be read, so they could not be put back afterwards");
  }
}
