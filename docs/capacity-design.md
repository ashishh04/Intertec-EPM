# Capacity — design

Capacity is how many hours a week a person is available for. It is EPM-owned, it lives on
the employee record that already exists, and it adds no new storage.

## Phase 1 — what the discovery found

### The field already exists and is already named

```prisma
/// Weekly capacity in hours, backing TeamMemberWorkload.hoursCapacity.
hoursCapacity Float @default(40)
```

Two independent places state the period. The schema comment says *weekly*, and
`TeamMemberWorkload.allocation` documents itself as *"0-100 percentage of the **weekly**
capacity that is allocated"*. There is no third reading anywhere, so the unit and period
were not chosen here — they were already settled and are simply being honoured.

`utilization` appears **nowhere** in the repository. `allocation` is the existing metric,
in 19 places.

### Existing consumers

| site | uses |
|---|---|
| `domain/employees.ts` | reports `hoursCapacity`, defaulting to 40 for an unmapped person |
| `routes/teams.ts` (`/teams/workloads`) | divides logged hours by it to produce `allocation` |
| `WorkloadList.tsx` | renders `hoursLogged / hoursCapacity` and an allocation label |
| `authz-test.ts` | asserts the default of 40 |

### The instance holds no data on either side

| measure | count |
|---|---|
| `user_profiles` rows | 0 |
| null / zero / negative `hoursCapacity` | 0 / 0 / 0 |
| OpenProject time entries | 0 |

So every capacity today is the schema default, and every `hoursLogged` is zero. Nothing
existing needs preserving, and nothing visible changes as a result of the correction
below.

### A defect in the existing `allocation`

```ts
const logged = hoursByUser.get(user.id) ?? 0;
allocation: capacity > 0 ? Math.min(100, Math.round((logged / capacity) * 100)) : 0
```

`hoursByUser` is built from `/time_entries` fetched with **no date filter** — every entry
ever recorded. That all-time total is then divided by a **weekly** capacity. Someone who
logged 400 hours over a year against 40 h/week yields 1000%, which the `Math.min(100, …)`
silently clamps to 100.

The field's own documentation says weekly, so the implementation disagrees with its stated
contract. It is invisible today only because the instance has no time entries. This is
corrected rather than built upon — see *Workload* below.

## Ownership

```
OpenProject identity  →  EPM UserProfile  →  hoursCapacity
```

Unchanged. No capacity is stored in OpenProject, no second employee table is created, and
no capacity table is added: one current value per person needs one column, and it already
exists.

## Semantics

| aspect | decision |
|---|---|
| unit | hours |
| period | one week |
| default | 40, from the schema. Applied to anyone with no profile row. |
| minimum | 0 |
| maximum | 168 — the number of hours in a week. A physical bound, not a policy one. |
| zero | **valid and meaningful**: this person contributes no capacity. They still count as a member. |
| decimals | allowed. 37.5 is a real contract; forcing integers would misrepresent it. |
| null | not representable. The column is `NOT NULL DEFAULT 40`, so capacity is always a number. An unmapped person reports the default rather than nothing. |
| negative | rejected. |

There is no "unset". Omitting capacity from a request changes nothing; there is no value
that means *unknown*, because the workload calculation would have to invent one anyway.

## Data model

**No migration.** `hoursCapacity` already exists with the right type, default and
nullability. Adding a capacity table would be storage for a question — *what was this
person's capacity last quarter* — that nothing in the product asks.

Deliberately **not** modelled, each recorded as a limitation rather than built: capacity
history, holidays, leave, working calendars, per-day schedules, forecasting.

## API

`PATCH /api/employees/:id/capacity`, body `{ "hoursCapacity": number }`.

**Separate from `/mapping`, deliberately.** The mapping endpoint writes department and team
*as a unit* precisely so the pair can be validated against each other and never lands
half-applied. Folding capacity into it would mean every capacity edit had to restate the
person's department and team — so a client that sent only capacity would clear their
placement. That is not a convenience duplicate; it is a different attribute with different
write semantics.

Reads need no new endpoint: `EpmEmployee` already carries `hoursCapacity`.

Aggregates ride on the resources that own them rather than getting endpoints of their own:

```ts
interface EpmTeam       { …, memberCount: number, capacityHours: number }
interface EpmDepartment { …, memberCount: number, capacityHours: number }
```

## Authorization

**`employees:manage`**, reused rather than extended.

Capacity is an attribute of the employee record, set by whoever does staffing — the same
responsibility that assigns people to departments and teams. Nothing in the requirements
distinguishes the two, there is no Roles UI through which a separate permission could be
granted to a different person, and a permission with no distinct holder is granularity
without a purpose. If that changes, adding `capacity:manage` is additive.

Enforced server-side on the write. The frontend hides the control it knows is unavailable;
that is presentation.

## Aggregation

```
Team capacity       = Σ hoursCapacity of people whose teamId = T
Department capacity = Σ hoursCapacity of people whose departmentId = D
```

Inclusion rules, decided explicitly rather than left to fall out of a query:

| case | included? | why |
|---|---|---|
| person present in the OpenProject directory | **yes** | the directory is the outer set everywhere else in this feature |
| profile row for someone no longer in the directory | **no** | an orphan of an upstream deletion is not a person; counting them would inflate totals invisibly |
| capacity of zero | **yes**, contributing 0 | they are a member with no availability, which is different from not being a member |
| unmapped person | **no** | they belong to no team and no department, so there is nothing to add them to |
| person in an archived team | **yes** | archiving is a visibility decision; the people are still there |
| person in an archived department | **yes** | same |
| empty team or department | **0**, not absent | zero capacity is the honest answer, not a missing one |

A person mapped to a department but no team counts toward that department and toward no
team. Department totals are computed from `departmentId` directly, not by summing teams, so
they do not depend on whether a team is archived.

The directory intersection also corrects `memberCount`, which previously counted profile
rows without it and so could disagree with the member list on the same page.

## Workload and utilization

`allocation` keeps its name and its place in the contract, and is corrected in two ways:

1. **Time entries are filtered to the current week** (`spent_on` with the `<>d` range
   operator, verified against the instance — a bogus filter name is rejected, so acceptance
   is real). Weekly logged hours over weekly capacity is what the field always claimed to
   be.
2. **The clamp is removed.** Overallocation is the single most useful thing a capacity
   feature can surface, and `Math.min(100, …)` hid exactly that. 130% now reports as 130.

Zero capacity is given an explicit representation rather than a number:

```
capacity = 0, logged = 10h   →   allocation: null
```

`null` means *undefined, because there is no capacity to divide by* — not zero, which
would read as "nothing logged". The type becomes `number | null` and the UI renders a dash.
This is the case the brief asks to be documented rather than left to produce `Infinity` or
a misleading percentage.

`assignedTasks` and the work-package query behind it are untouched.

## Frontend

- **Employees** — a capacity column, and a small dedicated editor. Not folded into
  `MappingDialog`, mirroring the API split for the same reason.
- **Teams list** — capacity alongside the member count.
- **Team detail** — members, capacity, logged hours and utilization, all from EPM's own
  model.
- **Reports** — the teams table regains a capacity column. It previously had one sourced
  from the OpenProject-group reading of teams, which was always zero and was removed with
  it; this one is backed by real EPM data.

## Known limitations

Recorded after implementation; see the end of this file.
