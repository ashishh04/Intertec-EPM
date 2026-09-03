# Portfolio — design

A portfolio is a named grouping of projects that EPM owns. It is how delivery is organised
for reporting, and it is the last structural relationship the org model was missing.

## Phase 1 — what the discovery found

### The existing field

```prisma
/// EpmProject.portfolio — "Platform", "Cloud", "Customer".
portfolio String?
```

Free text, exactly where `UserProfile.department` was before Employee Mapping. Consumers:
`EpmProject.portfolio` (a `string`), rendered on `ProjectCard` as `identifier · portfolio`
and searched in the command palette. Writable through `PATCH /projects/:id`, which accepts
any string and is gated on `project:edit`.

| measure | count |
|---|---|
| `project_profiles` rows | 0 |
| non-null `portfolio` values | 0 |
| distinct values | 0 |

Nothing to migrate. The column is **kept** rather than dropped — this database never held a
value, but the write path accepts arbitrary strings, so another deployment might.

### The project → team discovery

This was the important one. A project's people come from OpenProject memberships, and every
EPM employee is already mapped to exactly one team. So *which teams work on this project* is
**already computable**, with no new column:

```
project.memberIds → UserProfile.teamId → distinct teams
```

That is the model adopted. It is naturally many-to-many, cannot drift from who is actually
on the project, and unblocks the capacity and team rollups that Health and Capacity were
both missing — without adding a declaration that would need its own UI and could disagree
with membership.

The trade is stated plainly: this is **descriptive, not declarative**. It reflects who is a
member, including anyone with a viewing role, and it cannot express "Platform owns this
project" before a Platform member joins it. If ownership needs declaring later, that is an
additive column, not a reshape.

### Side finding

The instance holds **27 archived `Authz Test Project` records**, one per suite run. The
suite archives rather than deletes because OpenProject deletion is asynchronous and final.
Harmless — they are inactive and excluded from every list — but they accumulate. Noted, not
changed here.

## Semantics

Answered deliberately:

| question | answer | why |
|---|---|---|
| Can a project belong to one portfolio? | **Yes** | The existing field held one value; one is what the product implies. |
| Can a project belong to several? | **No** | Nothing asks for it, and many-to-many chosen for flexibility alone is the thing the brief warns against. Additive later if needed. |
| Does a portfolio contain projects only? | **Yes** | Teams arrive through the projects' members, derived. A portfolio does not hold teams directly. |
| Can a portfolio contain another portfolio? | **No** | No requirement asks for hierarchy, and nesting complicates every rollup. |
| Can an empty portfolio exist? | **Yes** | A portfolio is created before projects are put in it. |
| Can a portfolio be archived? | **Yes**, and restored | Matching departments and teams. |
| Can a project exist without a portfolio? | **Yes** | `portfolioId` is nullable. Most projects will start that way. |

## Ownership

```
OpenProject Project  →  EPM ProjectProfile  →  Portfolio
```

No EPM project entity is created. Nothing copies a project's name, identifier, status or
members — those stay OpenProject's, read live. `ProjectProfile.openProjectId` remains a
plain column, not a foreign key, because the row it names lives in another system.

## Schema

```prisma
model Portfolio {
  id          String   @id @default(cuid())
  /// Unique regardless of case, via a functional index on LOWER(name) — the
  /// same approach proven for departments and teams.
  name        String
  code        String   @unique
  description String?
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  projects    ProjectProfile[]

  @@index([active])
  @@map("portfolios")
}

model ProjectProfile {
  openProjectId String     @id
  /// Legacy free text. Superseded by portfolioId; kept, never written again.
  portfolio     String?
  portfolioId   String?
  portfolioRef  Portfolio? @relation(fields: [portfolioId], references: [id], onDelete: Restrict)
  …
  @@index([portfolioId])
}
```

`code` is included, matching departments and teams: a short unambiguous handle is what makes
these referenceable in conversation and in a filter. `RESTRICT` on the foreign key, for the
same reason as everywhere else — silently orphaning an association is worse than refusing a
delete.

Reads resolve the name and fall back:

```
EpmProject.portfolio = portfolioRef?.name ?? portfolio ?? ''
```

so a deployment with legacy text keeps displaying it until that project is linked. The
contract also gains `portfolioId`, so a picker can bind to the real reference.

## Lifecycle

Consistent with departments and teams, and with the rules Employee Mapping established:

| situation | behaviour |
|---|---|
| assigning a project to an **archived** portfolio | **refused** |
| portfolio archived while projects are in it | associations **retained, unchanged** |
| portfolio restored | unchanged, symmetrically |
| clearing a project's portfolio | always allowed, including out of an archived one |
| project archived or deleted upstream | the association is untouched; the project simply stops appearing, because the OpenProject project list is the outer set of every read |

Archiving stays a visibility decision. Nothing mass-mutates associations.

## API

| method | path | purpose |
|---|---|---|
| GET | `/api/portfolios` | list; `?includeInactive=true` |
| GET | `/api/portfolios/:id` | one portfolio |
| POST | `/api/portfolios` | create |
| PATCH | `/api/portfolios/:id` | update name, code, description |
| PATCH | `/api/portfolios/:id/archive` | deactivate |
| PATCH | `/api/portfolios/:id/restore` | reactivate |
| PATCH | `/api/projects/:id/portfolio` | associate or clear |
| GET | `/api/portfolios/:id/projects` | its projects, with their effective health |

The association gets its own route rather than riding on `PATCH /projects/:id`, which is
gated on the OpenProject-derived `project:edit` — the same reasoning that gave health its
own route. Portfolio membership is EPM's to grant.

## Authorization

**`portfolios:manage`**, new.

Departments, teams and employees each carry their own permission because each is a distinct
structural responsibility; grouping projects into portfolios is another one, typically a PMO
rather than whoever maintains the org chart or overrules a project's health. Reusing
`health:manage` would conflate judging a project's delivery with deciding which portfolio it
sits in.

One permission covers both creating portfolios and associating projects: they are the same
responsibility, and splitting them would be granularity with no distinct holder and no Roles
UI through which to assign it.

| operation | permission |
|---|---|
| list, read, rollups | authentication only |
| create, update, archive, restore, associate | `portfolios:manage` |

Granted from `epm_permission_grants` and the `EPM_ADMIN_USER_IDS` bootstrap. No new
mechanism.

## Rollups

Only what the existing model genuinely supports:

```ts
interface EpmPortfolio {
  …
  projectCount: number;        // projects associated, active or not
  activeProjectCount: number;
  health: { healthy: number; warning: number; critical: number };
  memberCount: number;         // distinct people across its projects
  capacityHours: number;       // their weekly hours, each counted once
  teams: { id: string; name: string }[];   // distinct teams of those people
}
```

**Health** reuses the effective project health already computed — override included. No
second calculation, and no portfolio-level single health verdict: rolling three states into
one needs a rule nobody has specified, so only the distribution is exposed and a single
verdict is recorded as future work.

**Capacity** reuses `hoursCapacity` unchanged. The one thing that needed deciding: a person
on two projects in the same portfolio must be counted **once**, so both `memberCount` and
`capacityHours` are computed over the distinct set of people. Summing per project would
double-count and quietly overstate a portfolio's capacity.

**Workload** is not rolled up. It would need logged hours attributed per project, and the
allocation semantics established in Capacity are per person and weekly. Combining them at
portfolio level needs a rule that does not exist. Recorded as a limitation rather than
approximated.

## Frontend

- **Portfolios page** — list with project counts, health distribution and status; a detail
  view with its projects, health summary and derived teams.
- **Project overview** — the portfolio it belongs to, with a change control for authorised
  users. Projects are not created here; OpenProject owns that.

## Known limitations

Recorded after implementation; see the end of this file.
