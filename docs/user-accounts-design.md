# User accounts — design

Creating a person was the last thing that forced you out of EPM and into the
OpenProject admin console. This closes that, and does one thing the console
cannot.

## Phase 1 — what the discovery found

Verified against the running 15.5.1 instance.

### "CRUD" does not map cleanly, and the reason is upstream

| | supported | how |
|---|---|---|
| Create | yes | `POST /api/v3/users`, `status: invited` — **no password** |
| Read | yes | `/api/v3/users`, admin-only |
| Update | yes | `updateImmediately` affordance → `PATCH` |
| Lock / unlock | yes | `lock` affordance → `POST`/`DELETE .../lock` |
| Delete | **off by default** | `users_deletable_by_admins` |

With the default settings, `DELETE /api/v3/users/:id` returns **403 to the
instance administrator**, no `delete` link appears on the resource, and no
capability advertises it. Deletion was enabled on this instance by explicit
decision; the code does not assume it, and reports the honest refusal where it
is off.

### The affordance set varies by account state

```
active   self memberships showUser updateImmediately  lock    delete
invited  self memberships showUser updateImmediately          delete
locked   self memberships          updateImmediately  unlock  delete
```

That is why every per-account action is gated on the resource's own links
rather than on a role. An invited account genuinely cannot be locked — `POST
.../lock` on one returns **406** — so a UI that offered the button would be
offering something upstream refuses. `delete` is additionally absent on the
caller's own account, which is why nobody is shown a delete button for
themselves.

### Capabilities cover creation only

```
users/create/g-4   users/read/g-4   users/update/g-4
```

Global, and there is no `users/delete`. So authorisation splits:

- **create, and the directory** — the `users:manage` permission, which
  `ACTION_GRANTS` already derived from `users/create` and `users/update` before
  this task. No new permission was invented.
- **update, lock, unlock, delete** — the affordance on that very account, read
  fresh from upstream on every request so a caller cannot assert their own.

Both are applied to every mutating route: the permission is the coarse gate, the
affordance the fine one.

### No password, ever

`status: "invited"` is a valid create payload with `login`, `firstName`,
`lastName` and `email` and **no password** — which is exactly what OpenProject's
own new-user form does. The person receives an invitation and sets their own
credentials. EPM never sees, stores or transmits a password, and the bundle
audit checks for the word.

## What EPM adds

OpenProject's new user form captures name, email, language and the admin flag.
It cannot capture a **department**, a **team** or a **weekly capacity**, because
it has no such concepts.

`POST /api/accounts` does both: it creates the account upstream, then writes the
EPM placement through the same `setMapping` and `setCapacity` the Employees page
already uses — so the same validation applies, including the rule that a team
belonging to a department settles the department.

That pairing is the entire reason this belongs in EPM rather than being a link
to `:8080`.

### When the second half fails

The account exists either way. Rolling it back would mean deleting a person
because their department was wrong, so the response carries
`placementProblems` and the UI says *"created, but not fully placed"* rather
than a blanket success or a misleading failure.

## API

| method | path | authorisation |
|---|---|---|
| GET | `/api/accounts` | `users:manage` |
| GET | `/api/accounts/:id` | `users:manage` |
| POST | `/api/accounts` | `users:manage` |
| PATCH | `/api/accounts/:id` | `users:manage` + `updateImmediately` |
| POST | `/api/accounts/:id/lock` | `users:manage` + `lock` |
| DELETE | `/api/accounts/:id/lock` | `users:manage` + `unlock` |
| DELETE | `/api/accounts/:id` | `users:manage` + `delete` |

Separate from `/api/users`, which stays exactly as it was: the ordinary
directory, built from principals, carrying no login, no account state and no
email for most callers. `/accounts` is the administration view and is admin-only
upstream, so exposing it under the existing path would have changed what every
other screen could see.

Deleting a person also removes their EPM `UserProfile` row, which is keyed on
someone who will no longer exist. Upstream returns **202** — the work is queued,
so the account disappears a moment later rather than immediately.

## Frontend

Everything lives on **Employees**, which was already the people page:

- **Add person** — one dialog, account plus placement.
- An **Account** column showing `active` / `invited` / `locked`, or `—` where
  the caller cannot read that person's account state. Absent, never guessed.
- Row actions rendered **only where the backend said the affordance exists** —
  so no lock button on an invited person, no unlock on an active one, and no
  delete where the instance forbids it.
- Deletion is confirmed, names what goes with it, and points at deactivation as
  the reversible alternative.

The reset effect is keyed on `account?.id`, not the object, for the same reason
as every sibling dialog: React Query returns a fresh object per refetch and
depending on it discards the user's input mid-edit.

## Test results

54 cases in `npm run test:authz`. Suite total **822 passed, 0 failed** — the 768
that existed before are unchanged.

The assertions that matter most:

- **the new person was placed in the department / and in the team / and given
  the capacity asked for** — read back through `/employees/:id`. This is the
  cross-system half actually working rather than the account being created and
  the placement silently dropped.
- **an invited account cannot be deactivated** — the affordance being honoured
  rather than a 406 surfacing from upstream.
- **the refused writes left the account alone / and did not make anyone an
  administrator** — refusals verified by re-reading, not by a status code.
- **their EPM placement was removed with them** — no orphan profile row.
- **no password is echoed back**.

Deletion is the section's own cleanup: the person created is the person deleted,
so the run cleans up by construction.

## An instance setting was changed

`users_deletable_by_admins` was **false** and is now **true**, by explicit
decision. Consequences worth recording:

- Deleting a person is irreversible and asynchronous. OpenProject reassigns or
  removes their work packages, comments and time entries as part of it.
- Nothing in the code depends on it. Turn it back off and the `delete`
  affordance disappears, the button disappears with it, and the route returns
  *"Deleting people is not enabled on this instance"* rather than failing
  obscurely.

## A test-suite defect this surfaced

The membership tests granted a real person real access to a real project and
only revoked it in the test that asserted removal. An aborted run therefore left
`restricted` holding **Project admin** on one project and **Member** on another
— which then made unrelated watcher and relation tests fail, because the account
genuinely had more permission than the suite assumed.

Grants are now registered the moment they are created and revoked first during
cleanup. A membership left behind is the one kind of leftover that changes what
another person can do, so it is cleaned up before anything else.

## Known limitations

1. **No password management.** Not setting one, not resetting one. Invitation
   and reset are OpenProject's, and EPM handling a credential would be strictly
   worse than not.
2. **The username cannot be changed after creation** through this UI. The API
   allows it; changing what someone signs in with from a personnel screen is a
   footgun.
3. **No bulk import.** One person at a time.
4. **No avatar upload, no identity-provider linking, no two-factor.** All
   OpenProject administration, none of it EPM's concern.
5. **Placeholder users and groups are not creatable.** Groups remain out of
   scope, and a placeholder is an Enterprise feature.
6. **The directory is capped at 100 people.** Enough for this instance; a larger
   one needs paging, which the endpoint supports.
7. **The Account column is only populated for callers holding `users:manage`.**
   Everyone else sees the Employees page exactly as before.
