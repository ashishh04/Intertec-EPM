/**
 * Two-factor authentication (`domain/mfa.ts`), through the API the way a browser
 * uses it: what a password alone can no longer do, what a code can, and what
 * nobody but the person, or an administrator, can change.
 *
 * Run from authz-test.ts with the suite's helpers, or on its own against a
 * running backend, since a full run takes a while:
 *
 *   npx tsx --env-file-if-exists=.env src/scripts/authz-mfa.ts
 *
 * It sets up an authenticator on the restricted account and removes it again,
 * however far the run gets. A code is good once, so it often waits for the next
 * thirty-second step, and signing in is limited to ten a minute per address, so
 * it paces itself. The lockout and the per-sign-in allowance are reached by
 * setting their counters in the database rather than by sending dozens of wrong
 * codes. The security notices it causes are removed from the outbox at the end, so
 * run the backend with EPM_EMAIL_WORKER_ENABLED=false and none is ever sent.
 */

import { totpCode, totpStep } from '../auth/totp.js';
import { prisma } from '../db/prisma.js';

type CallOptions = { method?: string; cookie?: string; body?: unknown };

export interface MfaContext {
  call: (path: string, options?: CallOptions) => Promise<Response>;
  status: (path: string, options?: CallOptions) => Promise<number>;
  check: (name: string, actual: unknown, expected: unknown) => void;
  admin: string;
  restricted: string;
  adminId: string;
  restrictedId: string;
  /** The restricted account's sign-in details. */
  credentials: { username: string; password: string };
  cleanup: { onCleanup(fn: () => Promise<void>): void };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cookiesFrom = (response: Response): Map<string, string> =>
  new Map(
    response.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0]!)
      .map((pair): [string, string] => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
      .filter(([, value]) => value !== ''),
  );

const asCookie = (name: string, value: string | undefined) => `${name}=${value ?? ''}`;

/**
 * Returns a new session on the restricted account for the suite to carry on
 * with: turning two-factor authentication on ends a person's other sessions,
 * and context.restricted is one of them.
 */
export async function mfaChecks(context: MfaContext): Promise<string> {
  const { call, status, check, admin, adminId, restrictedId, credentials } = context;

  console.log('\nTwo-factor authentication');

  // A stopped run must not leave the suite's account unable to sign in with a password.
  const policyBefore = await prisma.mfaPolicy.findUnique({ where: { id: 1 } });
  const startedAt = new Date();
  context.cleanup.onCleanup(async () => {
    await prisma.userMfa.deleteMany({ where: { openProjectId: restrictedId } });
    await prisma.mfaChallenge.deleteMany({ where: { openProjectId: restrictedId } });
    await prisma.emailOutbox.deleteMany({ where: { recipientId: restrictedId, template: 'security-notice', createdAt: { gte: startedAt } } });
    await prisma.mfaPolicy.deleteMany({ where: { id: 1 } });
    if (policyBefore) await prisma.mfaPolicy.create({ data: { id: 1, requiredRoles: policyBefore.requiredRoles, updatedBy: policyBefore.updatedBy } });
  });
  await prisma.userMfa.deleteMany({ where: { openProjectId: restrictedId } });
  await prisma.mfaPolicy.deleteMany({ where: { id: 1 } });
  // Other servers forget within fifteen seconds; this one is the suite's only.
  await call('/admin/mfa/policy', { method: 'PUT', cookie: admin, body: { requiredRoles: [] } });

  /* -- Pacing ------------------------------------------------------------- */

  // Signing in and its second half each allow ten a minute per address.
  const recent: Record<string, number[]> = { login: [], verify: [] };
  const paced = async (bucket: 'login' | 'verify') => {
    const list = recent[bucket]!;
    while (list.length > 0 && Date.now() - list[0]! > 60_000) list.shift();
    if (list.length >= 7) await sleep(60_000 - (Date.now() - list[0]!) + 500);
    list.push(Date.now());
  };

  const login = async (password = credentials.password): Promise<Response> => {
    await paced('login');
    return call('/auth/login', { method: 'POST', body: { username: credentials.username, password } });
  };

  const verify = async (challengeCookie: string, code: string): Promise<Response> => {
    await paced('verify');
    return call('/auth/mfa/verify', { method: 'POST', cookie: challengeCookie, body: { code } });
  };

  /** A session on the restricted account while it has no authenticator. */
  const plainSession = async (): Promise<string> => {
    const response = await login();
    return asCookie('epm.sid', cookiesFrom(response).get('epm.sid'));
  };

  /* -- Who may ask -------------------------------------------------------- */

  check('nobody cannot read two-factor status', await status('/auth/mfa'), 401);
  check('nobody cannot start a set-up', await status('/auth/mfa/setup', { method: 'POST', body: {} }), 401);
  check('nobody cannot confirm a set-up', await status('/auth/mfa/confirm', { method: 'POST', body: { code: '123456' } }), 401);
  check('nobody cannot turn it off', await status('/auth/mfa/disable', { method: 'POST', body: { code: '123456' } }), 401);
  check('nobody cannot read the administration view', await status('/admin/mfa'), 401);
  check('the restricted account cannot read the administration view', await status('/admin/mfa', { cookie: context.restricted }), 403);
  check(
    'the restricted account cannot change who must use it',
    await status('/admin/mfa/policy', { method: 'PUT', cookie: context.restricted, body: { requiredRoles: [] } }),
    403,
  );
  check(
    'the restricted account cannot reset anyone',
    await status(`/admin/mfa/users/${adminId}/reset`, { method: 'POST', cookie: context.restricted }),
    403,
  );
  check('a code with no sign-in waiting is refused', await status('/auth/mfa/verify', { method: 'POST', body: { code: '123456' } }), 410);
  check('an empty code is refused', await status('/auth/mfa/verify', { method: 'POST', body: { code: '' } }), 400);

  /* -- Setting it up ------------------------------------------------------ */

  const person = await plainSession();
  const second = await plainSession();

  const before = (await (await call('/auth/mfa', { cookie: person })).json()) as Record<string, unknown>;
  check('it starts off', before.enabled, false);
  check('and is not required', before.required, false);
  check('a fresh session is not asked for its password', before.passwordRequired, false);

  const setupResponse = await call('/auth/mfa/setup', { method: 'POST', cookie: person, body: {} });
  check('someone can start setting it up', setupResponse.status, 200);
  const setup = (await setupResponse.json()) as { secret: string; uri: string; issuer: string };
  check('the secret is 160 bits of base32', /^[A-Z2-7]{32}$/.test(setup.secret), true);
  check('the QR address is an authenticator address', setup.uri.startsWith('otpauth://totp/'), true);
  check('and carries the secret', setup.uri.includes(`secret=${setup.secret}`), true);
  check('and never names the delivery system', /openproject/i.test(`${setup.uri} ${setup.issuer}`), false);

  const stored = await prisma.userMfa.findUnique({ where: { openProjectId: restrictedId } });
  check('the secret is not stored in the clear', Boolean(stored && !stored.secret.includes(setup.secret)), true);

  // Every step used from here on moves forward: a code is good once.
  let lastStep = 0;
  const nextCode = async (): Promise<string> => {
    // One step ahead of the clock is accepted, which saves most of the waiting.
    // Otherwise the newest it can be, so a slow response does not age it out.
    while (lastStep + 1 > totpStep() + 1) await sleep(1_000);
    lastStep = Math.max(lastStep + 1, totpStep());
    return totpCode(setup.secret, lastStep);
  };
  const wrongCode = () => {
    const window = [-1, 0, 1].map((offset) => totpCode(setup.secret, totpStep() + offset));
    return ['000000', '111111', '222222', '333333'].find((code) => !window.includes(code))!;
  };

  check(
    'a wrong code does not turn it on',
    await status('/auth/mfa/confirm', { method: 'POST', cookie: person, body: { code: wrongCode() } }),
    400,
  );
  check('so an unfinished set-up still signs in with a password alone', cookiesFrom(await login()).has('epm.sid'), true);

  const confirmResponse = await call('/auth/mfa/confirm', { method: 'POST', cookie: person, body: { code: await nextCode() } });
  check('the right code turns it on', confirmResponse.status, 200);
  const { recoveryCodes } = (await confirmResponse.json()) as { recoveryCodes: string[] };
  check('and gives ten recovery codes', recoveryCodes.length, 10);
  check('all different', new Set(recoveryCodes).size, 10);
  check('in the shape people are shown', recoveryCodes.every((code) => /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/.test(code)), true);

  const hashes = await prisma.mfaRecoveryCode.findMany({ where: { openProjectId: restrictedId } });
  check('only hashes of them are kept', hashes.some((row) => recoveryCodes.some((code) => row.codeHash.includes(code.replace(/-/g, '')))), false);

  check('the session that turned it on stays signed in', await status('/me', { cookie: person }), 200);
  check('their other sessions are ended', await status('/me', { cookie: second }), 401);
  check(
    'it cannot be set up twice',
    await status('/auth/mfa/setup', { method: 'POST', cookie: person, body: {} }),
    409,
  );
  const after = (await (await call('/auth/mfa', { cookie: person })).json()) as Record<string, unknown>;
  check('it now reads as on', after.enabled, true);
  check('with ten codes left', after.recoveryCodesLeft, 10);

  /* -- A password alone --------------------------------------------------- */

  check('a wrong password is still just a wrong password', (await login('definitely-not-the-password')).status, 401);

  const passwordOnly = await login();
  const passwordOnlyBody = (await passwordOnly.json()) as Record<string, unknown>;
  const issued = cookiesFrom(passwordOnly);
  check('the right password answers OK', passwordOnly.status, 200);
  check('but says a code is needed', passwordOnlyBody.mfaRequired, true);
  check('and that nobody is signed in', passwordOnlyBody.authenticated, false);
  check('and issues no session', issued.has('epm.sid'), false);
  const challenge = asCookie('epm.mfa', issued.get('epm.mfa'));
  check('only a challenge', issued.has('epm.mfa'), true);
  check('which reads no data', await status('/me', { cookie: challenge }), 401);
  check('and is not a session', await status('/auth/session', { cookie: challenge }), 401);
  check('and cannot change the protection', await status('/auth/mfa/disable', { method: 'POST', cookie: challenge, body: { code: '123456' } }), 401);
  check('and is not listed as a session', (await prisma.session.count({ where: { id: issued.get('epm.mfa')?.split('.')[0] ?? '' } })), 0);

  check('a tampered challenge cookie is refused', await status('/auth/mfa/verify', { method: 'POST', cookie: `${challenge}x`, body: { code: '123456' } }), 410);

  const wrong = await verify(challenge, wrongCode());
  check('a wrong code is refused', wrong.status, 400);
  check('and opens nothing', cookiesFrom(wrong).has('epm.sid'), false);

  const code = await nextCode();
  const right = await verify(challenge, code);
  check('the right code signs in', right.status, 200);
  const session = asCookie('epm.sid', cookiesFrom(right).get('epm.sid'));
  check('with a working session', await status('/me', { cookie: session }), 200);
  check('the challenge is spent', await status('/auth/mfa/verify', { method: 'POST', cookie: challenge, body: { code } }), 410);

  const again = asCookie('epm.mfa', cookiesFrom(await login()).get('epm.mfa'));
  const replay = await verify(again, code);
  check('the same code cannot be used twice', replay.status, 400);
  check('and says why', /just been used/.test(((await replay.json()) as { message: string }).message), true);

  /* -- Too many wrong codes ----------------------------------------------- */

  await prisma.mfaChallenge.updateMany({ where: { openProjectId: restrictedId }, data: { attempts: 4 } });
  check('the fifth wrong code on one sign-in is refused', (await verify(again, wrongCode())).status, 400);
  check('and after it the password is needed again', (await verify(again, await nextCode())).status, 410);
  check('so that sign-in is gone', await prisma.mfaChallenge.count({ where: { openProjectId: restrictedId } }), 0);
  // That right code was never spent, so step back: it would otherwise wait out a step.
  lastStep -= 1;

  const onlyOne = asCookie('epm.mfa', cookiesFrom(await login()).get('epm.mfa'));
  const newer = asCookie('epm.mfa', cookiesFrom(await login()).get('epm.mfa'));
  check('a newer sign-in retires the one before', (await verify(onlyOne, '000000')).status, 410);

  await prisma.userMfa.update({ where: { openProjectId: restrictedId }, data: { failedAttempts: 9 } });
  check('the tenth wrong code in a row is refused', (await verify(newer, wrongCode())).status, 400);
  const lockedRow = await prisma.userMfa.findUnique({ where: { openProjectId: restrictedId } });
  check('and locks six-digit codes', Boolean(lockedRow?.lockedUntil && lockedRow.lockedUntil.getTime() > Date.now()), true);
  const minutesLocked = (row: { lockedUntil: Date | null } | null) =>
    Math.ceil(((row?.lockedUntil?.getTime() ?? 0) - Date.now()) / 60_000);
  check('for a quarter of an hour', minutesLocked(lockedRow), 15);
  check('and the run of wrong codes outlasts the lock', lockedRow?.failedAttempts, 10);

  const whileLocked = await verify(newer, await nextCode());
  check('even the right code is refused while locked', whileLocked.status, 409);
  check('and says when it can be tried again', /Try again in/.test(((await whileLocked.json()) as { message: string }).message), true);
  lastStep -= 1;

  // A guesser who waits each lock out, reached through the counters again.
  const lockAfter = async (failures: number) => {
    await prisma.userMfa.update({ where: { openProjectId: restrictedId }, data: { failedAttempts: failures - 1, lockedUntil: null } });
    await prisma.mfaChallenge.updateMany({ where: { openProjectId: restrictedId }, data: { attempts: 0 } });
    const refused = await verify(newer, wrongCode());
    return { status: refused.status, minutes: minutesLocked(await prisma.userMfa.findUnique({ where: { openProjectId: restrictedId } })) };
  };
  const secondLock = await lockAfter(20);
  check('ten more wrong codes are refused', secondLock.status, 400);
  check('and lock for twice as long', secondLock.minutes, 30);
  const longestLock = await lockAfter(100);
  check('it stops doubling at a day', longestLock.minutes, 24 * 60);
  const whileLockedLong = await verify(newer, await nextCode());
  check('a long lock is given in hours', /Try again in 24 hours/.test(((await whileLockedLong.json()) as { message: string }).message), true);
  lastStep -= 1;

  const lockedOut = await verify(newer, recoveryCodes[0]!.toUpperCase().replace(/-/g, ' '));
  check('a recovery code still signs in, however it was typed', lockedOut.status, 200);
  const recoveryBody = (await lockedOut.json()) as { via: string; recoveryCodesLeft: number };
  check('and says it was one', recoveryBody.via, 'recovery');
  check('and how many are left', recoveryBody.recoveryCodesLeft, 9);
  const unlocked = await prisma.userMfa.findUnique({ where: { openProjectId: restrictedId } });
  check('and lifts the lock', unlocked?.lockedUntil, null);
  check('and ends the run of wrong codes', unlocked?.failedAttempts, 0);

  const secondTime = asCookie('epm.mfa', cookiesFrom(await login()).get('epm.mfa'));
  check('a recovery code works once', (await verify(secondTime, recoveryCodes[0]!)).status, 400);

  /* -- New recovery codes ------------------------------------------------- */

  check(
    'new recovery codes need a code',
    await status('/auth/mfa/recovery-codes', { method: 'POST', cookie: person, body: { code: wrongCode() } }),
    400,
  );
  const fresh = await call('/auth/mfa/recovery-codes', { method: 'POST', cookie: person, body: { code: await nextCode() } });
  check('with one, there are ten new ones', fresh.status, 200);
  const { recoveryCodes: newCodes } = (await fresh.json()) as { recoveryCodes: string[] };
  check('that are not the old ones', newCodes.some((entry) => recoveryCodes.includes(entry)), false);
  check('the old ones stop working', (await verify(secondTime, recoveryCodes[1]!)).status, 400);

  /* -- Turning it off ----------------------------------------------------- */

  // A session someone walked away from: past the ten minutes a password stays proved.
  const personSessionId = (person.split('=')[1] ?? '').split('.')[0] ?? '';
  await prisma.session.update({ where: { id: decodeURIComponent(personSessionId) }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } });
  const stale = (await (await call('/auth/mfa', { cookie: person })).json()) as Record<string, unknown>;
  check('an older session is told it will be asked for its password', stale.passwordRequired, true);

  const noPassword = await call('/auth/mfa/disable', { method: 'POST', cookie: person, body: { code: await nextCode() } });
  check('turning it off from an older session needs the password', noPassword.status, 400);
  check(
    'and says it is the password it wants, so the page can ask',
    ((await noPassword.json()) as { details?: { field?: string } }).details?.field,
    'password',
  );
  // Refused before the code was looked at, so that one is still good.
  lastStep -= 1;
  check(
    'the right one, not just any',
    await status('/auth/mfa/disable', { method: 'POST', cookie: person, body: { code: await nextCode(), password: 'definitely-not-the-password' } }),
    400,
  );
  lastStep -= 1;
  check(
    'and a code, not just the password',
    await status('/auth/mfa/disable', { method: 'POST', cookie: person, body: { code: wrongCode(), password: credentials.password } }),
    400,
  );
  check('so it is still on', await prisma.userMfa.count({ where: { openProjectId: restrictedId, confirmedAt: { not: null } } }), 1);
  check(
    'with both, it goes',
    await status('/auth/mfa/disable', { method: 'POST', cookie: person, body: { code: await nextCode(), password: credentials.password } }),
    204,
  );
  check('its recovery codes go with it', await prisma.mfaRecoveryCode.count({ where: { openProjectId: restrictedId } }), 0);
  check('and a password alone signs in again', cookiesFrom(await login()).has('epm.sid'), true);

  /* -- Required by role --------------------------------------------------- */

  check(
    'a role that does not exist cannot be required',
    await status('/admin/mfa/policy', { method: 'PUT', cookie: admin, body: { requiredRoles: ['nobody'] } }),
    422,
  );
  check(
    'an administrator can require it of a role',
    await status('/admin/mfa/policy', { method: 'PUT', cookie: admin, body: { requiredRoles: ['employee'] } }),
    200,
  );

  const heldMe = (await (await call('/me', { cookie: person })).json()) as Record<string, unknown>;
  check('someone in that role is told to set it up', heldMe.mfaSetupRequired, true);
  check('their session reaches no data until they do', await status('/projects', { cookie: person }), 403);
  check('nor can they write', await status('/me', { method: 'PATCH', cookie: person, body: { firstName: 'Held' } }), 403);
  check('but can read who they are', await status('/me', { cookie: person }), 200);
  check('and their preferences', await status('/preferences', { cookie: person }), 200);
  check('and their two-factor status', await status('/auth/mfa', { cookie: person }), 200);
  check('a role it is not required of carries on', await status('/projects', { cookie: admin }), 200);
  const adminMe = (await (await call('/me', { cookie: admin })).json()) as Record<string, unknown>;
  check('and is not told to set it up', adminMe.mfaSetupRequired, false);

  const required = (await (await call('/auth/mfa', { cookie: person })).json()) as Record<string, unknown>;
  check('their status says it is required', required.required, true);

  const secondSetup = await call('/auth/mfa/setup', { method: 'POST', cookie: person, body: { password: credentials.password } });
  check('they can set it up from there, with their password', secondSetup.status, 200);
  const secondSecret = ((await secondSetup.json()) as { secret: string }).secret;
  const stepNow = totpStep();
  check(
    'and once they have',
    await status('/auth/mfa/confirm', { method: 'POST', cookie: person, body: { code: totpCode(secondSecret, stepNow) } }),
    200,
  );
  check('they reach their data at once', await status('/projects', { cookie: person }), 200);
  const released = (await (await call('/me', { cookie: person })).json()) as Record<string, unknown>;
  check('and are no longer told to', released.mfaSetupRequired, false);

  const view = (await (await call('/admin/mfa', { cookie: admin })).json()) as {
    policy: { requiredRoles: string[] };
    people: { userId: string; enabled: boolean; required: boolean }[];
  };
  const listed = view.people.find((row) => row.userId === restrictedId);
  check('the administration view shows it on', listed?.enabled, true);
  check('and required', listed?.required, true);
  check('and the policy', view.policy.requiredRoles.join(), 'employee');
  check('and gives away no secret', JSON.stringify(view).includes(secondSecret), false);

  check(
    'a role can stop being required',
    await status('/admin/mfa/policy', { method: 'PUT', cookie: admin, body: { requiredRoles: [] } }),
    200,
  );

  /* -- An administrator's reset ------------------------------------------- */

  check(
    'an administrator cannot reset their own',
    await status(`/admin/mfa/users/${adminId}/reset`, { method: 'POST', cookie: admin }),
    400,
  );
  check(
    'but can reset someone who has lost their phone',
    await status(`/admin/mfa/users/${restrictedId}/reset`, { method: 'POST', cookie: admin }),
    204,
  );
  check('which signs them out everywhere', await status('/me', { cookie: person }), 401);
  check(
    'and cannot be done twice',
    await status(`/admin/mfa/users/${restrictedId}/reset`, { method: 'POST', cookie: admin }),
    409,
  );
  const signedInAgain = cookiesFrom(await login());
  check('a password alone signs them in again', signedInAgain.has('epm.sid'), true);

  /* -- The record --------------------------------------------------------- */

  const journal = (await (await call(`/journal?action=mfa.&pageSize=50`, { cookie: admin })).json()) as {
    items?: { action: string; entityId: string }[];
  };
  const actions = new Set((journal.items ?? []).filter((entry) => entry.entityId === restrictedId).map((entry) => entry.action));
  for (const action of ['mfa.enabled', 'mfa.disabled', 'mfa.reset', 'mfa.locked', 'mfa.recovery-used', 'mfa.recovery-regenerated']) {
    check(`the journal records ${action}`, actions.has(action), true);
  }
  check('and holds no secret', JSON.stringify(journal).includes(setup.secret), false);

  const notices = await prisma.emailOutbox.count({ where: { recipientId: restrictedId, template: 'security-notice' } });
  check('the person is told by email', notices > 0, true);

  return asCookie('epm.sid', signedInAgain.get('epm.sid'));
}

/* -------------------------------------------------------------------------- */
/* On its own                                                                  */
/* -------------------------------------------------------------------------- */

async function standalone(): Promise<void> {
  const base = process.env.AUTHZ_BASE_URL ?? 'http://localhost:8000/api';
  const adminLogin = { username: process.env.AUTHZ_ADMIN_USER ?? 'admin', password: process.env.AUTHZ_ADMIN_PASSWORD ?? 'Admin@12345' };
  const restrictedLogin = {
    username: process.env.AUTHZ_RESTRICTED_USER ?? 'restricted',
    password: process.env.AUTHZ_RESTRICTED_PASSWORD ?? 'Restricted!12345',
  };

  const call = (path: string, options: CallOptions = {}) =>
    fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  const signIn = async (credentials: { username: string; password: string }) => {
    const response = await call('/auth/login', { method: 'POST', body: credentials });
    if (!response.ok) throw new Error(`Sign-in failed for ${credentials.username}: ${response.status}`);
    return response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  };

  let passed = 0;
  let failed = 0;
  const check = (name: string, actual: unknown, expected: unknown) => {
    const ok = actual === expected;
    ok ? (passed += 1) : (failed += 1);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (expected ${String(expected)}, got ${String(actual)})`}`);
  };

  const cleanups: (() => Promise<void>)[] = [];
  try {
    const admin = await signIn(adminLogin);
    const restricted = await signIn(restrictedLogin);
    const idOf = async (cookie: string) => ((await (await call('/me', { cookie })).json()) as { id: string }).id;

    await mfaChecks({
      call,
      status: async (path, options) => (await call(path, options)).status,
      check,
      admin,
      restricted,
      adminId: await idOf(admin),
      restrictedId: await idOf(restricted),
      credentials: restrictedLogin,
      cleanup: { onCleanup: (fn) => cleanups.push(fn) },
    });
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/authz-mfa.ts')) {
  await standalone();
}
