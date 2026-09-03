# Departments — design

The first EPM-owned domain. Everything before this was a view onto OpenProject;
a department exists only in EPM and has no upstream counterpart.

## Phase 1 — what the discovery found

### Backend architecture

There is no controller/service/repository stack. Routes in `src/routes/*.ts` are
registered by `src/routes/index.ts`, call `openProject` or `prisma` directly, and
delegate shape conversion to `src/mapping/*.ts`. Departments follow that: data access
and validation live in `src/domain/departments.ts`, the route file stays thin. A
layered architecture is not introduced, because none exists to match.

### Existing database models

`schema.prisma` holds nine models, all **overlays**: every one is keyed by
`openProjectId` and adds columns OpenProject has no home for. `Department` is the
first model that is not an overlay — it owns its own identity.

That distinction matters for `src/db/prisma.ts`, whose `optional()` helper degrades a
missing database to "serve OpenProject data without EPM overlays". A missing
department is not a missing overlay field; it is the whole feature. Department routes
therefore do **not** use `optional()` and surface a database failure as an error.

### Existing department representation — found, and left alone

`UserProfile.department` is a free-text `String?`, surfaced as `EpmUser.department` and
displayed read-only on Profile and Settings. It is **not** migrated to a foreign key in
this task. Linking employees to departments belongs to the Employee-mapping work that
follows Teams, and backfilling arbitrary strings needs a matching policy that is out of
scope here. The two coexist: the free-text field keeps working exactly as before.

### Authorization

`departments:manage` already exists in `PERMISSIONS` and is listed in `UNMAPPED`:
*"Department is EPM-owned metadata; no upstream equivalent."* Because no `ACTION_GRANTS`
entry maps to it, `allows()` returned false for **every** user including the
administrator — the permission existed but could never be held.

Verified against the instance:

| principal | global capabilities |
|---|---|
| admin (4) | `projects/create`, `users/create`, `users/read`, `users/update`, `placeholder_users/*` |
| restricted (6) | none |

So an upstream signal exists that discriminates the two. It was **not** used. Deriving
`departments:manage` from `users/create` would say "whoever may administer OpenProject
principals may administer EPM's org structure", which is an assumption about intent, and
the instruction was explicitly not to equate OpenProject administration with EPM
department administration.

### How OpenProject user ids are represented

As `String`, matching the EPM `ID` type, on every overlay's `openProjectId`. There is no
EPM user table and none is added. `Department.managerId` holds an OpenProject user id as
a plain column with **no foreign key**, because the referenced row lives in another
system. Display names resolve through `getUsers()` in `src/mapping/users.ts`, the same
cached directory the comment routes use for authors.

## Ownership boundary

| owned by OpenProject | owned by EPM |
|---|---|
| projects, work packages, statuses, roles | department identity, name, code, description |
| users — identity, name, email, avatar | which user manages a department |
| capabilities and per-record affordances | who may administer departments |

A department stores a manager's **id and nothing else**. No name, no email. Copying
either would create a second, staler answer to a question OpenProject already answers.

## Domain model

```
Department
  id           opaque EPM id
  name         human label, unique
  code         short key, unique, normalized uppercase
  description  optional free text
  managerId    optional OpenProject user id, no FK
  active       lifecycle flag
  createdAt / updatedAt
```

## Database model

```prisma
model Department {
  id          String   @id @default(cuid())
  name        String   @unique
  code        String   @unique
  description String?
  /// OpenProject user id. Deliberately not a relation: OpenProject owns users,
  /// and a foreign key here would require duplicating them into this database.
  managerId   String?
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([active])
  @@map("departments")
}

model EpmPermissionGrant {
  openProjectId String
  permission    String
  grantedAt     DateTime @default(now())
  grantedBy     String?

  @@id([openProjectId, permission])
  @@map("epm_permission_grants")
}
```

`@@index([active])` is justified by the list route, which filters on it by default.
`managerId` is not indexed: nothing looks a department up by manager yet, and an index
with no reader is cost without benefit.

### Uniqueness

`code` and `name` are both unique at the database level. Codes are normalized to
uppercase before writing, so `ENG` and `eng` collide in Postgres as well as in the
application. Names are compared case-insensitively **in the application only** — a
case-insensitive uniqueness index would need raw SQL outside Prisma's schema and would
show as drift on the next migration. That limitation is recorded below.

## API contract

| method | path | purpose |
|---|---|---|
| GET | `/api/departments` | list; `?includeInactive=true` to include deactivated |
| GET | `/api/departments/:id` | one department |
| POST | `/api/departments` | create |
| PATCH | `/api/departments/:id` | update name, code, description, manager |
| PATCH | `/api/departments/:id/archive` | deactivate |
| PATCH | `/api/departments/:id/restore` | reactivate |

There is **no** `DELETE`. Teams, employee mappings and portfolio will all reference
departments, and a hard delete would orphan those references. This mirrors the
established project lifecycle, `PATCH /projects/:id/archive`, whose own comment reads
*"Archive rather than delete."*

Response shape:

```ts
interface EpmDepartment {
  id: string;
  name: string;
  code: string;
  description?: string;
  manager?: { id: string; name: string };   // resolved through the user directory
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
```

`manager` is an object, not a bare id, so the client never has to join against the
directory itself — the same choice made for comment authors.

## Authorization model

Two permissions, both enforced server-side:

| operation | permission | source |
|---|---|---|
| list, read | authentication only | departments are org reference data, like `/catalog/*`, which carries no guard |
| create, update, archive, restore | `departments:manage` | EPM-native grant |

`department:create` / `:edit` / `:delete` were evaluated and **not** introduced. Three
extra permissions with no distinct source, no way to assign them separately, and no UI
to tell them apart would be invented granularity. `departments:manage` already exists in
the vocabulary and covers every write.

### Where the grant comes from

A second authoritative source is added to permission resolution: `epm_permission_grants`,
an EPM table for EPM-owned permissions. `loadPermissions()` merges rows for the signed-in
user into the **global** permission set after reading OpenProject's capabilities.

This does not compete with the existing model, it completes a gap the existing model had
already documented. OpenProject stays the only source for everything it knows about;
EPM becomes the source for the permission OpenProject has no concept of.

Bootstrapping is by explicit configuration:

```
EPM_ADMIN_USER_IDS=4
```

Comma-separated OpenProject user ids, read at startup and treated as holding
`departments:manage`. This is configuration, not a hardcoded username check — the ids
come from the environment, nothing in the source names a user, and the variable is
optional (unset means no one holds the permission until a row is granted).

There is no grant-assignment API in this task. Managing grants is the Roles feature.

## Frontend contract

The established chain, unchanged:

```
DepartmentsPage → useDepartments → ApiDepartmentRepository → EPM BFF :8000
```

The page reads `can('departments:manage')` from `AuthProvider` to decide whether to
render create/edit/archive controls. That is presentation only; every write is
re-checked by the backend, which is what actually enforces it.

## Relationships to future work

Nothing here anticipates Teams or Portfolio beyond leaving room for them:

- **Teams** will reference a department, one direction only — department knows nothing
  about its teams.
- **Employee mapping** will replace `UserProfile.department` with a reference, and is
  where the free-text field is reconciled.
- **Portfolio** is a separate EPM-owned entity; departments do not own portfolios.

No columns, tables or endpoints are added for any of these now.

## Migration strategy

One additive migration following the existing convention (a `migration.sql` under a
timestamped directory). It creates two tables and takes no locks on existing data —
nothing is altered, so no backfill and no downtime.

## Validation rules

| field | rule |
|---|---|
| name | required, trimmed, 1–120 chars, unique (case-insensitive check in the app) |
| code | required, trimmed, uppercased, 2–16 chars, `[A-Z0-9-]` only, unique |
| description | optional, trimmed, ≤ 2000 chars, empty becomes null |
| managerId | optional; must be a user the caller can see in the directory |
| active | not settable through create or update — the lifecycle routes own it |

A duplicate name or code is a 409, not a 500 from a constraint violation.

## Test results

53 cases in `npm run test:authz`, run against the live stack. Suite total **300 passed,
0 failed** — the 247 that existed before are unchanged.

Coverage: permission surfaced on `/me` for both identities; anonymous refused on read and
write; read allowed without the grant; create/update/archive refused without it; ten
validation cases; code normalisation; duplicate code, duplicate name and case-variant
duplicates; partial update leaving omitted fields alone; clearing a manager; the archive
and restore round trip with list visibility either side; absence of a delete route; three
unknown-id cases; and a check that a department response carries no upstream reference.

Database constraints were verified directly against Postgres rather than only through the
API:

```
departments_code_key    UNIQUE btree (code)
departments_name_key    UNIQUE btree (name)
departments_active_idx  btree (active)
epm_permission_grants_pkey  UNIQUE btree (openProjectId, permission)
active  boolean NOT NULL DEFAULT true

duplicate code            -> rejected, P2002
duplicate name            -> rejected, P2002
name differing by case    -> ACCEPTED at the database, rejected by the application
```

That last line is limitation 1 below, confirmed rather than assumed.

The UI was driven end to end in a real browser for both identities: create, list, edit,
archive, reveal via the archived toggle, and client-side validation feedback — all
passing, with the create button absent for the caller without the grant. Every route
clean of console errors, and the only origins contacted were `localhost:8000` and Google
Fonts. Bundle audit: zero occurrences of `openproject`, `localhost:8080`, `Bearer`,
`Authorization`, `access_token`, `refresh_token`, `api/v3`, `apikey` or `EPM_ADMIN`.

## Test data

None left behind. The suite records the ids it creates and removes them in its cleanup
step; because there is deliberately no delete route, that one step goes through the
database directly, which is the only place the suite reaches past the API. Departments
and permission-grant rows both end at zero.

## Unresolved questions and limitations

1. **Case-insensitive name uniqueness is application-level.** Two names differing only
   in case can race past the check under concurrent creates; the database would accept
   both. A raw `CREATE UNIQUE INDEX ON departments (lower(name))` would close it but sits
   outside Prisma's schema and reports as drift.
2. **`UserProfile.department` is still free text** and unreconciled with this table.
3. **No grant-assignment API.** Grants are bootstrapped from the environment and
   otherwise written directly to the database until Roles exists.
4. **`managerId` has no referential integrity.** A user deleted in OpenProject leaves a
   dangling id; the API reports the manager as unresolved rather than failing.
5. **Departments are not yet referenced by anything**, so the archive-instead-of-delete
   rule is a forward-looking constraint rather than one the data currently enforces.
