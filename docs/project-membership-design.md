# Project membership — design

Adding someone to a project was the last stub left in the project pages. It is
also the thing every derived number was waiting on: workload, team rollups and
portfolio capacity all count people, and there was no way to change who they
were without leaving EPM.

## Phase 1 — what the discovery found

Verified against the running 15.5.1 instance, not the documentation.

### The shape of a membership

```
id, createdAt, updatedAt
_links.project     /api/v3/projects/2
_links.principal   /api/v3/users/4
_links.roles       [{ href: /api/v3/roles/5, title: "Project admin" }]
```

A membership has **its own id**, distinct from the user's. That id is what a
role change or a removal acts on, so both travel together in the contract —
using the person's id instead is the easy way to act on the wrong record.

### There is no delete affordance

This is the finding that shaped the authorization design.

```
_links.self               /api/v3/memberships/3
_links.schema             /api/v3/memberships/schema
_links.update             /api/v3/memberships/3/form
_links.updateImmediately  /api/v3/memberships/3
```

No `delete`. Confirmed by creating a membership as an administrator who was
certainly permitted to delete it, reading its links back, and then deleting it
successfully — `DELETE /api/v3/memberships/3` returned **204**.

So the affordance-driven pattern used for watchers, relations and comments has
nothing to key on here. Rather than invent an affordance upstream does not
publish, authorization uses the per-project capability — which `ACTION_GRANTS`
already mapped before this task:

```ts
'memberships/read':    ['member:view'],
'memberships/create':  ['member:manage'],
'memberships/update':  ['member:manage'],
'memberships/destroy': ['member:manage'],
```

and which OpenProject reports per project:

```
memberships/create/p2-4    context: /api/v3/projects/2
memberships/destroy/p2-4   context: /api/v3/projects/2
```

The permission plumbing was already complete. What was missing was routes that
enforced it.

### OpenProject computes both lists this needs

Two filters do work EPM would otherwise do badly:

| need | filter |
|---|---|
| roles grantable on a project | `/roles?filters=[{"unit":{"operator":"=","values":["project"]}}]` → Project admin, Reader, Member |
| who may still be added | `/principals?filters=[{status ≠ 3}, {member ≠ <projectId>}]` — neither locked nor already a member |

The role filter matters: `/roles` unfiltered returns twelve, including global
roles and the builtin Anonymous and Non member, none of which can be granted on
a project. `grantable=t` still lets a global role through; `unit=project` is the
correct one.

The candidate filter matters more: it means EPM never subtracts one list from
another and gets it wrong.

## What is stored

**Nothing.** There is no EPM table here and no migration. Memberships live in
OpenProject, which is where projects and users already live, and every write
goes straight through. That is not a limitation — it is why the change shows up
in `memberIds`, the workload list and portfolio rollups without a sync step:
they all derive from the same `/memberships` collection.

## API

| method | path | permission |
|---|---|---|
| GET | `/api/project-roles` | none — instance configuration |
| GET | `/api/projects/:id/members` | none; OpenProject scopes the collection |
| GET | `/api/projects/:id/members/candidates` | `member:manage` in that project |
| POST | `/api/projects/:id/members` | `member:manage` in that project |
| PATCH | `/api/projects/:id/members/:membershipId` | `member:manage` in that project |
| DELETE | `/api/projects/:id/members/:membershipId` | `member:manage` in that project |

### Why the list is not guarded

An earlier draft guarded it on `member:view`, and that was wrong. OpenProject
already scopes `/memberships` to what the caller may see, so a reader gets an
empty list from upstream. Adding a check on top returned **403 where the system
of record returns nothing**, and disagreed with `memberIds` on the project
payload — which is derived from the same collection and shows `[]` for the same
user. Every other read in this codebase relies on upstream scoping; this now
does too.

The candidate list *is* guarded, because it is the instance user directory
filtered by a project, and someone who cannot add anyone has no reason to
enumerate it.

### The check that is not about permissions

```ts
if (!membership || linkId(membership._links, 'project') !== projectId) {
  throw EpmError.notFound('That membership does not exist on this project.');
}
```

`member:manage` is granted **per project**. Without anchoring the record to the
project in the URL, holding it on any one project would be enough to change or
delete a membership in any other simply by putting its id in the path. Reported
as missing rather than forbidden: whether a membership exists elsewhere is not
this caller's business.

## Roles

One role per membership through this UI, though OpenProject allows several. The
list shows every role a membership carries, and the editor changes the first.
Multi-role memberships are left to OpenProject rather than half-represented
here — offering a picker that silently discards the other two would be worse
than not offering one.

Role ids are validated as numeric before they are put in a URL, and an empty
role list is rejected: it is required upstream, and a membership with no role
grants nothing.

## Notifications and mail

**OpenProject emails the person it just granted access to.** That is left on:
being added to a project is exactly what someone needs to know, and suppressing
it silently would be a worse default than a mail EPM did not send itself.

**No EPM notification is created.** It would duplicate a message upstream has
already delivered, which is precisely what the notification design says not to
do.

## Frontend

- `MemberDialog` — add someone, or change the role of someone already there.
  One dialog, because the two differ only in whether the person is chosen.
- The project **Team** tab lists members with their **project role** — not the
  account's instance role, which is what it showed before and is a different
  thing.
- Row actions appear only where the backend said `canManage`.
- Removal is confirmed, because it revokes access. Reversible by adding the
  person back, but not by an undo.
- Both `Invite` stubs — the project header and the Team tab — now open the
  dialog. Neither shows a toast any more.

The reset effect is keyed on `member?.membershipId`, not the object, for the
same reason as the sibling dialogs: React Query returns a fresh object on every
refetch, and depending on it discards the user's selection mid-edit.

## Test results

34 cases in `npm run test:authz`. Suite total **770 passed, 0 failed** — the 736
that existed before are unchanged.

Both directions are covered. Adding, changing and removing work; and the refusals
are asserted to have **changed nothing**, by re-reading the list rather than
trusting a status code.

Two assertions matter more than the rest:

- **the change reflects in the project payload** — `memberIds` after an add and
  after a remove. This is the write-through actually working; without it the
  feature could pass every other test and still be an EPM-only illusion.
- **a membership cannot be patched or deleted through a different project** —
  the id-manipulation case, asserted in both directions.

### Two test-design errors the run surfaced

Both mine, and both are the feature working correctly:

1. The project was chosen as "the first one with candidates", which selected an
   archived test project with **no members** — making every assertion about the
   existing list vacuously true. It now requires both existing members and an
   addable candidate.
2. `otherRoleId` resolved to **Project admin**, and the only candidate on this
   instance is the restricted user. So the suite promoted its own test subject
   to Project admin and then asserted they could not manage members — they
   could, correctly. The role now prefers Reader, and the denial checks run
   *before* anything is added, against **someone else's** membership, which is
   the case that actually matters.

### Test data

The membership created is removed by the same test that asserts removal works,
so the section cleans up by construction rather than by a separate step. Final
member counts match the initial ones, verified through the API and through
`memberIds`.

## Known limitations

1. **One role per membership through this UI.** OpenProject supports several;
   the editor changes the first and the list displays all.
2. **Groups and placeholder users are not offered.** The candidate endpoint
   returns them and they are filtered out — EPM has no group concept, and
   inventing half of one here would be worse than omitting them. Adding a group
   to a project stays an OpenProject operation.
3. **No user creation.** This adds *existing* people to projects. Creating an
   account is a heavier, admin-only operation upstream, and `/api/users` remains
   read-only.
4. **No bulk add.** One person at a time.
5. **The project owner is not protected.** Removing the person shown as Owner is
   permitted if OpenProject permits it; `ownerId` comes from the `responsible`
   link, which is a separate field from membership, and inventing a rule that
   couples them would be EPM overriding upstream.
6. **Mail cannot be suppressed.** OpenProject's `notify=false` exists but is not
   exposed; adding a toggle would be a preference, and there is nowhere to put
   one yet.
