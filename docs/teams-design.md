# Teams — design

The second EPM-owned domain, and the first that replaces something rather than adding to
it.

## Phase 1 — what the discovery found

### A Teams feature already existed

`/teams` read OpenProject **groups**, decorated with a `TeamProfile` overlay holding
`slug`, `description` and `leadId`. `EpmTeam` carried `memberIds`, `projectIds`,
`capacity` and `sprintProgress`, derived from group membership and project memberships.

The instance defines **zero groups**, so every one of those fields was empty or zero and
both `TeamsPage` and `TeamDetailPage` rendered an empty list. The feature could not be
used without someone first creating a group in OpenProject.

Consumers found: `TeamsPage`, `TeamDetailPage`, `ReportsPage` (filter dropdown, id and
name only), `CommandPalette` (id and name), `Breadcrumbs` (name), and
`ProjectTeamTab` — which calls `useTeamWorkloads()` with **no** team id, so it lists a
project's member workloads and does not depend on Teams at all.

### Decision: replace

An EPM-owned `Team` becomes the source of truth and `/teams` serves it. `TeamProfile` is
retired. Nothing visible is lost, because the fields being dropped were already empty on
this instance, and each belongs to a feature that has not been built:

| dropped from `EpmTeam` | belongs to |
|---|---|
| `memberIds` | Employee Mapping |
| `projectIds` | Portfolio |
| `capacity`, `sprintProgress` | Capacity |
| `slug` | nothing — it was a derived display value |

`/teams/workloads` is kept as-is: `ProjectTeamTab` depends on it and it is about people,
not teams.

## Ownership boundary

| owned by OpenProject | owned by EPM |
|---|---|
| users — identity, name, email, avatar | team identity, name, code, description |
| projects, work packages, statuses, roles | which department a team belongs to |
| groups — no longer used to model teams | which user leads a team |
| | who may administer teams |

A team stores a lead's **OpenProject user id and nothing else**, exactly as a department
stores its manager. Names resolve through `getUsers()` at read time.

## Domain model and cardinality

Answered deliberately, not assumed:

| question | answer | why |
|---|---|---|
| Can one department have many teams? | **Yes** | The obvious org shape, and the only one the department archive rule has to reason about. |
| Does a team belong to exactly one department? | **At most one** | `departmentId` is nullable. Requiring one would make Teams unusable until an org chart exists, and would block the common case of a team that is genuinely cross-departmental. |
| Can a team exist without a department? | **Yes** | Follows from the above. It is a valid, not a broken, state. |
| Can a team move between departments? | **Yes** | `PATCH /teams/:id` with a new `departmentId`. Reorganisations happen; there is no reason to force delete-and-recreate. |
| Can a department be archived while it holds active teams? | **Yes**, teams unchanged | See *Lifecycle* below. |
| Can a team be archived independently? | **Yes** | Its own `active` flag, its own archive/restore routes. |
| Is the team name unique globally or per department? | **Globally**, case-insensitively | A team with no department has no scope to be unique within, so per-department uniqueness is undefined for exactly the case that makes it necessary. Teams are also referenced globally — the command palette and the reports filter list them flat — where two same-named teams would be indistinguishable. |
| Is the team code unique globally or per department? | **Globally** | Same reasoning. A code exists to be a short unambiguous handle; scoping it to a department removes the property that makes it useful. |
| Does a team have a lead? | **Yes** | `TeamProfile.leadId` already existed with these semantics, so this is continuity rather than a new idea. |
| How is that identity represented? | An **OpenProject user id**, no foreign key | Identical to `Department.managerId`. See *Identity* below. |
| What if the upstream user disappears? | Reported as `Unknown user` | The read succeeds; a dangling id does not break a page. |

Deliberately **not** modelled: members, projects, capacity, health, portfolio. Each is a
later feature, and adding a column now would be guessing at its shape.

## Database schema

```prisma
model Team {
  id           String      @id @default(cuid())
  name         String
  code         String      @unique
  description  String?
  /// Nullable: a team may exist before the org chart does, or span departments.
  departmentId String?
  department   Department? @relation(fields: [departmentId], references: [id], onDelete: Restrict)
  /// OpenProject user id. Not a relation — OpenProject owns users.
  leadId       String?
  active       Boolean     @default(true)
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt

  @@index([departmentId])
  @@index([active])
  @@map("teams")
}
```

`Department` gains `teams Team[]` — the reverse side Prisma requires. It adds no column.

### Constraints

| constraint | how | why |
|---|---|---|
| `code` unique | `@unique`, values uppercased before writing | So `ENG` and `eng` collide in Postgres, not just in the application. |
| `name` unique, case-insensitively | `CREATE UNIQUE INDEX teams_name_lower_key ON teams (LOWER(name))` | Prisma cannot express an expression index, so raw SQL, the same approach taken for departments in `20260903120000`. `@unique` is deliberately absent from the model so Prisma does not create a redundant plain index. |
| `departmentId` references a real department | Foreign key, `ON DELETE RESTRICT` | Restrict rather than SetNull: silently orphaning a team is worse than refusing the delete. Departments have no delete route, so this only ever fires against direct database access — which is exactly where the protection is wanted. |
| department lookup | `@@index([departmentId])` | The list route filters by it. |
| lifecycle filter | `@@index([active])` | The list route filters by it by default. |

`leadId` is not indexed: nothing looks a team up by lead yet.

## Lifecycle

Teams archive and restore; there is no delete, matching departments and projects.

**Department archived → teams unchanged.** Archiving is a visibility decision, not a
structural one, and it must stay reversible. Cascading would need a separate record of
which teams were *already* archived, or restore would silently reactivate teams that were
retired on purpose.

**Department restored → teams unchanged**, symmetrically.

**Creating a team in an archived department is refused.** Retaining an existing
association is not the same as forming a new one into something being retired.

**Moving a team into an archived department is refused**, for the same reason.

A team whose department is archived is still listed, still readable, still editable, and
can still be moved to an active department — that is how it is un-stranded.

## API contract

| method | path | purpose |
|---|---|---|
| GET | `/api/teams` | list; `?departmentId=`, `?includeInactive=true` |
| GET | `/api/teams/:id` | one team |
| POST | `/api/teams` | create |
| PATCH | `/api/teams/:id` | update name, code, description, department, lead |
| PATCH | `/api/teams/:id/archive` | deactivate |
| PATCH | `/api/teams/:id/restore` | reactivate |
| GET | `/api/teams/workloads` | unchanged; about people, not teams |

```ts
interface EpmTeam {
  id: string;
  name: string;
  code: string;
  description?: string;
  department?: { id: string; name: string; active: boolean };
  lead?: { id: string; name: string };
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
```

`department` and `lead` are objects rather than bare ids, so no client has to join
against another endpoint to render a row — the same choice made for department managers
and comment authors. `department.active` is included because a team can outlive its
department's archival and the UI needs to say so.

`EpmTeam` moves **out** of the synced `types/index.ts` contract and into the domain and
service files, matching how attachments, relations, comments and departments are defined.
`TeamMemberWorkload` stays in the synced contract — `ProjectTeamTab` still uses it.

## Authorization

`teams:manage` already exists in `PERMISSIONS`, listed in `UNMAPPED` as *"Teams map to
OpenProject groups, which expose no capability."* That note is now wrong in its reasoning
and right in its conclusion: teams no longer map to groups, and there is still no upstream
capability — because a team is not an OpenProject concept at all.

It is added to the grantable set in `auth/grants.ts` alongside `departments:manage`, so it
is granted from `epm_permission_grants` and the `EPM_ADMIN_USER_IDS` bootstrap. No new
environment variable, no new mechanism.

A separate permission rather than reusing `departments:manage`: the vocabulary already
distinguished them, both are grantable independently, and collapsing two existing
permissions into one would be a narrowing, not a simplification.

| operation | permission |
|---|---|
| list, read | authentication only — teams are reference data, like departments |
| create, update, archive, restore | `teams:manage` |

Server-side on every write. The frontend hides controls it knows are unavailable; that is
presentation, and the backend refuses regardless.

## Identity — the lead

```
EPM Team.leadId  →  OpenProject user id  →  resolved via getUsers()
```

No EPM user table is created and no OpenProject user data is copied. The id is validated
on write against the directory the caller can see, so a team cannot be used to probe for
accounts. On read, an id that resolves to nobody is reported as `Unknown user` rather than
failing the request.

This is the same boundary Departments use for `managerId`. When Employee Mapping arrives
it will introduce an EPM-side employee record; `leadId` will then be reconsidered against
it, which is a migration of one nullable column.

## Frontend contract

```
TeamsPage → useTeams → ApiTeamRepository → EPM BFF → EPM PostgreSQL
```

`TeamsPage` is rewritten in the Departments style: a list with create, edit, archive and
restore, a department filter, an archived toggle, and write controls gated on
`can('teams:manage')`. `TeamDetailPage` keeps only what EPM owns — name, code,
description, department, lead, status — and loses the member, project and capacity panels,
which were rendering zeroes.

## Relationship to future Employee Mapping

Employee Mapping will add membership as its own table, `(teamId, employeeId)`, not as a
column here. Nothing in this schema anticipates it beyond leaving the id stable.

## Known limitations

Recorded after implementation; see the section at the end of this file.
