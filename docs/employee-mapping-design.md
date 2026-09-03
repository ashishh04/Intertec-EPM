# Employee Mapping — design

The bridge between OpenProject identity and EPM's org structure. It adds no people; it
records where the people OpenProject already knows about sit in EPM's departments and
teams.

## Phase 1 — what the discovery found

### `UserProfile` is already the EPM-side employee record

```prisma
model UserProfile {
  openProjectId String   @id
  department    String?   // free text
  hoursCapacity Float    @default(40)
  timezone      String?
  createdAt / updatedAt
}
```

Keyed by the OpenProject user id, holding exactly the per-person attributes OpenProject
has no column for. That is what an employee record is here, so it is **extended** rather
than shadowed by a second table. A separate `EmployeeMapping` keyed 1:1 to this would be
indirection with no second row to justify it.

### The table is empty, and nothing writes it

Three read sites — `mapping/users.ts` (twice) and `routes/teams.ts` — and **zero writes**
anywhere in the codebase. No API creates or updates a profile. Confirmed against the
database: `profiles=0`.

This is the single most consequential finding, because it settles Phases 3 and 9: there
is no free-text department data to migrate, and there never was. See *Migration* below.

### The directory

`getUsers()` walks `/principals` (pageSize 100, all pages), drops `Group` and
`PlaceholderUser`, joins project roles from `/memberships`, and caches the result in
`referenceCache` for 5 minutes. `/users` proper is admin-only and 403s for a normal
token, which is why principals are the source and why `email` is empty for everyone but
the caller.

The instance has **2 users**: `4` (OpenProject Admin) and `6` (Restricted User), both
active. There is no server-side search or pagination on this endpoint — it returns the
whole directory, which at this size is correct.

`referenceCache.invalidate('users')` exists, so a mapping write can drop the cached
directory rather than leaving a stale department name for up to five minutes.

### Existing consumers

| site | uses | effect of this work |
|---|---|---|
| `ProfilePage`, `SettingsPage` | `EpmUser.department` (read-only) | now shows the mapped department name instead of always empty |
| `/teams/workloads` | `UserProfile.hoursCapacity` | unchanged; gains a working `teamId` filter |
| `TeamsPage`, `TeamDetailPage` | `EpmTeam` | gains member counts and a member list |

`memberIds` and `sprintProgress` still appear in the repository, but on **projects** and
the dashboard — `EpmProject.memberIds` comes from OpenProject project memberships. Nothing
is left over from the group-backed teams that were replaced.

## Identity ownership

| owned by OpenProject | owned by EPM |
|---|---|
| user identity, id, login | which department a person belongs to |
| name, email, avatar, account status | which team a person belongs to |
| permissions and capabilities | weekly capacity hours, timezone |

No EPM user table is created. `UserProfile.openProjectId` is a plain column, not a foreign
key, because the row it refers to lives in another system. A person exists in EPM only as
a mapping keyed by their OpenProject id; delete them upstream and the mapping is an inert
orphan, not a broken page.

## Data model

**Option A — extend `UserProfile`.** Chosen.

```prisma
model UserProfile {
  openProjectId String      @id
  /// Legacy free text. Superseded by departmentId; kept, not dropped.
  department    String?
  departmentId  String?
  departmentRef Department? @relation(fields: [departmentId], references: [id], onDelete: Restrict)
  teamId        String?
  team          Team?       @relation(fields: [teamId], references: [id], onDelete: Restrict)
  hoursCapacity Float       @default(40)
  timezone      String?
  createdAt / updatedAt

  @@index([departmentId])
  @@index([teamId])
}
```

Option B (a separate `EmployeeMapping`) was rejected: the relationship to `UserProfile`
would be exactly 1:1, so it would add a join and a second identity key without adding a
fact. Historical mapping is **not** modelled — nothing in the current requirements reads
"which team was this person on last quarter", and building an audit trail for a question
nobody asks is cost without a reader. If it is needed later it is an additive table, not
a reshape of this one.

Both foreign keys are `RESTRICT`, matching `Team → Department`: silently orphaning a
mapping is worse than refusing a delete.

Rows are created on demand. A person with no mapping has no row, which is why every read
path treats a missing profile as "unmapped" rather than an error.

## The department/team invariant

A team belongs to at most one department. Storing both a department and a team on a person
makes a contradiction expressible — *department = Finance, team = Platform (Engineering)* —
so the backend forbids it:

> **If a person is assigned a team, and that team belongs to a department, the person's
> department is that team's department.**

Enforced two ways in one operation:

- The department is **derived** from the team, so the state cannot drift.
- An explicitly supplied `departmentId` that contradicts the team is **rejected**, rather
  than silently overwritten. A caller who states both gets told they disagree.

A team with no department constrains nothing; the department is then set independently. A
person may have a department and no team. A person may have neither.

Mapping is written as a **unit** — one request carries both fields — so there is no
intermediate state where the pair is inconsistent. That also answers what happens when the
department changes: the request states the whole mapping, and the UI clears the team field
when the department changes so a new one must be chosen deliberately.

## Lifecycle

Consistent with the rules already established for departments and teams:

| situation | behaviour |
|---|---|
| assigning to an **archived** department or team | **refused** |
| department or team archived while people are mapped to it | mappings **retained, unchanged** |
| department or team restored | mappings unchanged, symmetrically |
| clearing a mapping | always allowed, including out of an archived entity |

Archiving stays a visibility decision. Nothing mass-mutates people's assignments, and
restore needs no record of what to undo.

## Migration of `UserProfile.department`

**There is nothing to migrate.**

| measure | count |
|---|---|
| `user_profiles` rows | 0 |
| non-null `department` values | 0 |
| distinct values | 0 |
| case-insensitive duplicates | 0 |
| values matching an existing department | 0 |
| unmatched values | 0 |
| ambiguous values | 0 |

The column has no writer anywhere in the codebase, so it was never populated. No matching
rules were applied, no fuzzy matching was considered, and no value was reclassified,
because there was no value.

The column is **kept, not dropped**, for two reasons: the instruction not to remove it
immediately, and because a deployment elsewhere might hold data this one does not. Reads
prefer the mapping and fall back to it:

```
EpmUser.department = mappedDepartment?.name ?? UserProfile.department ?? ''
```

So an environment with legacy free text keeps displaying it until that person is mapped,
at which point the authoritative value takes over. Nothing is lost and nothing is guessed.
A verification script that inventories and classifies values ships with the work so the
same check can be run against any other database before that column is ever removed.

## Authorization

A new permission: **`employees:manage`**.

Neither existing permission fits. `departments:manage` and `teams:manage` are about
designing the org structure — creating, renaming and retiring departments and teams.
Assigning people into that structure is a different responsibility, commonly held by
different people, and requiring both would mean nobody could staff a team without also
being able to delete it.

Added to `PERMISSIONS`, recorded in `UNMAPPED` (OpenProject has no concept of an EPM
department, so nothing upstream implies it), and added to the grantable set in
`auth/grants.ts` alongside the other two. It is granted from `epm_permission_grants` and
the `EPM_ADMIN_USER_IDS` bootstrap — no new mechanism, no new environment variable.

| operation | permission |
|---|---|
| list employees, read a mapping | authentication only |
| assign or clear a mapping | `employees:manage` |

Server-side on every write.

## API contract

| method | path | purpose |
|---|---|---|
| GET | `/api/employees` | directory with mappings; `?departmentId=`, `?teamId=`, `?unmapped=true`, `?q=` |
| GET | `/api/employees/:id` | one person with their mapping |
| PATCH | `/api/employees/:id/mapping` | set both fields as a unit; `null`/`""` clears |
| GET | `/api/teams/:id/members` | people mapped to a team |

```ts
interface EpmEmployee {
  id: string;            // the OpenProject user id — not EPM's
  name: string;
  email?: string;
  avatarUrl?: string;
  department?: { id: string; name: string; active: boolean };
  team?: { id: string; name: string; active: boolean };
  hoursCapacity: number;
}
```

There is no create, no delete, and no way to edit a name or email. Employees are not an
EPM resource; only the mapping is. The list is the OpenProject directory left-joined onto
EPM rows, so a person with no mapping still appears — which is the point, since that is
who needs assigning.

`EpmTeam` gains `memberCount`, cheap enough to include on the list and what
`TeamsPage` needs. It is **not** the old `memberIds`: it counts EPM mappings, never
OpenProject group membership.

## `/teams/workloads`

The `teamId` parameter previously validated and discarded. It now scopes the result to
people mapped to that team.

This is correct without any Capacity work, because scoping only changes *which people* are
measured — each person's numbers are computed the same way they always were, from their own
assigned work packages and time entries. Nothing about a team enters the arithmetic. An
empty or unmapped team returns an empty list rather than the whole directory, which was the
previous behaviour and the reason the parameter was inert.

## Frontend

```
EmployeesPage → useEmployees → ApiEmployeeRepository → EPM BFF → EPM PostgreSQL + directory
```

A table of people with their department and team, search, department and team filters, and
a mapping dialog. The team select lists only teams valid for the chosen department;
changing the department clears the team so a compatible one is chosen deliberately. All of
that is convenience — the backend rejects an invalid pair regardless of what the UI sends.

Write controls render on `can('employees:manage')`.

## Known limitations

Recorded after implementation; see the end of this file.
