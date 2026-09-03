# Health — design

Health is EPM's management read on a project: is delivery going well, is it slipping, is it
in trouble. It is layered over OpenProject's data and does not replace OpenProject status.

## Phase 1 — what the discovery found

### Most of this already exists

`computeHealth()` in `mapping/projects.ts` is a complete, deterministic calculation over
four dimensions plus a derived overall, and `ProjectOverviewTab` already renders all five
with a `HealthIndicator`. 140 references to health across the repository.

```ts
type HealthLevel = 'healthy' | 'warning' | 'critical';
interface ProjectHealth { scope; schedule; resources; budget; overall }
```

### The gap

`ProjectProfile.healthOverride` exists in the schema as `Json?`, with the comment *"Set to
pin a health dimension that the computed rules get wrong"*, and is declared on the
`ProjectOverlay` interface — **and is never read**. Two references in the whole codebase:
the schema and the type. Nothing writes it and nothing applies it.

So this feature is not "build health". It is: apply the override that was designed for and
never wired, make the existing rules explainable, and expose the three-way distinction the
schema comment already implies.

### Inventory

| measure | count |
|---|---|
| `project_profiles` rows | 0 |
| non-null `healthOverride` | 0 |

Nothing to preserve or migrate.

## Health states

Three, unchanged — no state is invented:

| state | meaning |
|---|---|
| `healthy` | Delivery is on track on this dimension. Also what a project with no work packages reports, rather than alarming about an empty project. |
| `warning` | Slipping. Worth a conversation, not an escalation. |
| `critical` | In trouble on this dimension. |

## Calculation

Unchanged in behaviour. The thresholds were inline literals and are now named constants, so
every rule is readable and none is a hidden magic number. `band(ratio, warning, critical)`
returns `critical` at or above the critical threshold, `warning` at or above the warning
one, otherwise `healthy`.

```
overdueRatio = overdue / total
openRatio    = (total - completed) / total

schedule  = band(overdueRatio, 0.10, 0.25)     how much of the work is already late
scope     = pastDue && openRatio > 0.10        the due date passed with work outstanding
              ? critical
              : band(openRatio, 0.60, 0.85)    how much remains open
resources = band(overdueRatio, 0.15, 0.35)     overdue work as the symptom of under-resourcing
budget    = healthy                            no source on this instance; see below
overall   = worst(scope, schedule, resources, budget)
```

`total === 0` short-circuits to all-healthy. Every ratio has a non-zero denominator by
construction, so there is no divide-by-zero and no `NaN`.

Each dimension now also carries a **reason** — a plain sentence naming the figures it was
computed from, e.g. *"3 of 12 work packages are overdue (25%)."* Health that cannot be
explained is health nobody trusts.

### Why capacity and allocation are not inputs

They were evaluated and deliberately excluded.

Capacity is measured in **hours per week**. The demand signal available per project is a
**count of work packages** — open, completed, overdue. Turning a task count into hours
needs an assumed hours-per-task, which is precisely the invented constant the rules are
meant to avoid; and the alternative, comparing logged hours to capacity, measures effort
already spent rather than work outstanding.

There is also no project→team relationship. A project's members come from OpenProject
memberships and its people are mapped to EPM teams, but nothing says "this team owns this
project" — that is Portfolio, which is a later feature.

So `resources` keeps its existing, honest definition: overdue work is the observable
symptom of under-resourcing. When estimates or a project→team link exist, this is the
dimension to revisit.

### Budget

Always `healthy`. `ProjectProfile` has `budgetTotal` and `budgetUsed`, but both are zero on
every project here and nothing writes them, so a computed budget dimension would be a
statement about data that does not exist. It stays healthy and is the clearest candidate
for an override until a real figure arrives.

## Override

The existing `healthOverride` JSON column, read as a **partial map of dimension to level**:

```json
{ "schedule": "healthy", "overall": "warning" }
```

| aspect | behaviour |
|---|---|
| allowed values | `healthy`, `warning`, `critical`, on any of the five dimensions |
| storage | a value per dimension, not a flag — the schema comment says *pin a dimension*, and a flag could not say what to pin it to |
| null / absent | that dimension is not overridden and the calculated value stands |
| `{}` | every override cleared |
| partial | supported and expected; overriding `schedule` leaves the other four calculated |
| unknown keys | rejected, so a typo does not become a silently ignored override |

### Effective health

```
effective[d] = override[d] ?? calculated[d]           for scope, schedule, resources, budget
effective.overall = override.overall
                 ?? worst(effective scope, schedule, resources, budget)
```

Two consequences worth stating. Overriding one dimension **moves the overall**, because
overall is recomputed from the effective values rather than the calculated ones — pinning
`schedule` to healthy is meant to change the headline. And `overall` can itself be
overridden, which is how a manager says "I know how it looks; I have it in hand" without
rewriting each dimension.

`EpmProject.health` is the **effective** health, so every existing consumer — the dashboard,
the projects grid, the overview tab, reports — shows the managed value without changing.
The calculated value and the override travel alongside it:

```ts
interface EpmProject {
  health: ProjectHealth;              // effective — what to display
  healthCalculated: ProjectHealth;    // what the rules produced, always
  healthOverride?: Partial<Record<HealthDimension, HealthLevel>>;
  healthReasons: Record<HealthDimension, string>;
}
```

Keeping `healthCalculated` visible is deliberate: an override that hides the underlying
signal from the person reading it is a way to lose information, not to manage it.

## API

`PATCH /api/projects/:id/health`, body a partial map of dimension to level. `{}` clears
everything; `{"schedule": null}` clears one.

**Its own route, not the existing `PATCH /projects/:id`.** That handler is gated on
`project:edit`, which is derived from OpenProject's `projects/update` capability — and the
requirement is explicit that health authority is not OpenProject's to grant. A separate
route keeps the two permissions from having to share a handler.

Reads need no new endpoint: the project contract carries all four fields.

## Authorization

A new permission: **`health:manage`**.

None of the existing EPM-owned grants fits. `departments:manage`, `teams:manage` and
`employees:manage` are org-structure and staffing authority — who exists and where they
sit. Overriding a project's health is a delivery judgement, typically a PMO or delivery
manager rather than whoever maintains the org chart. Reusing one would mean granting
someone the ability to restructure departments in order to let them mark a project amber.

The OpenProject-derived `project:edit` was rejected on the requirement's own terms: health
is EPM-owned, so its authority is EPM's to grant.

Added to `PERMISSIONS`, recorded in `UNMAPPED` (OpenProject has no concept of EPM health),
and added to the grantable set in `auth/grants.ts`. Granted from `epm_permission_grants`
and the `EPM_ADMIN_USER_IDS` bootstrap — no new mechanism, no new environment variable, no
Roles UI.

| operation | permission |
|---|---|
| view health, calculated and override | authentication only |
| set, change or clear an override | `health:manage` |

## Thresholds

No threshold configuration exists in the schema, and none is added. The five constants live
in `mapping/projects.ts` as named values with the rules that use them — in the backend, not
React. A configuration subsystem for five numbers nobody has asked to change would be cost
without a reader; when a requirement to tune them arrives, they are already isolated.

## Team and department health

**Not implemented.** Nothing in the current requirements asks for it, and there is no
project→team relationship to aggregate project health through — the same gap that keeps
capacity out of the calculation. Inventing a second algorithm over capacity and workload
would be duplicate business logic for a question nobody has asked.

Recorded as a future requirement, dependent on Portfolio.

## UI

- **Project overview** — the existing five-dimension health card gains an override marker
  per dimension, the calculated value shown alongside an overridden one, and an editor for
  authorised users.
- **Projects grid and dashboard** — unchanged code, now showing effective health.
- **Reports** — a health breakdown by state, counted from effective health.

Write controls render on `can('health:manage')`; the backend refuses regardless.

## Test results

64 cases in `npm run test:authz`. Suite total **545 passed, 0 failed** — the 481 that
existed before are unchanged.

The calculation is a pure function, so its boundaries are tested directly rather than
through a project whose numbers cannot be arranged. **Both sides of every threshold** are
asserted — 9/10 and 24/25 on schedule, 14/15 and 34/35 on resources, 41/40 and 16/15 open
on scope — rather than only comfortable mid-range values. Plus: the past-due escalation and
its 5%-open counter-case; a future due date not escalating; the three headline conditions;
overall being the worst dimension rather than an average; and an empty project reporting
healthy *with a reason that says why*, so it does not read as a clean bill of health.

Determinism is asserted directly: the same inputs 50 times produce byte-identical output. A
sweep over every `(total, completed, overdue)` combination up to 20 confirms no input
produces a level outside the three — no `NaN`, no `Infinity`, no empty string.

Override resolution covers undefined, empty, one pinned dimension, all four pinned moving
overall, and overall pinned alone leaving the dimensions showing the truth. Reading a
stored value covers `null`, `{}`, an array, a string, an unknown dimension and an unknown
level — the last two dropped rather than thrown on, so a malformed row cannot take a
project page down.

Through the API: anonymous 401, ungranted 403 with the value verified unchanged after,
three validation refusals, an unknown project 404, and the set/change/clear cycle with the
calculated value confirmed still visible beneath the pin. The dashboard at-risk count is
asserted to move **in both directions** with the pin, so a summary cannot contradict the
project page it summarises.

Driven in a browser for both identities: the health card, reasons, the override dialog
showing calculated values, setting, changing and clearing a pin, the "Overridden" marker on
both the project page and Reports. The restricted identity saw health and reasons but
**zero** override buttons. Every route clean of console errors; only `localhost:8000` and
Google Fonts contacted; bundle audit zero on all nine patterns.

### A bug the sweep caught

The dialog's reset effect depended on the whole `project` object. React Query hands back a
fresh object on every refetch, so a background refetch mid-edit reset the form and
discarded what the user had chosen — the first override save in the sweep landed empty
because of it. Fixed to depend on `project.id`. The same pattern was present in the four
sibling dialogs written for departments, teams, employee mapping and capacity, and all four
were fixed too.

## Test data

Snapshotted and restored. The suite records each project's override before pinning
anything and writes it back through the API afterwards, including "there was no pin", which
is a value too. Pinning upserts a project profile, so rows left holding nothing are removed
as well — a row carrying portfolio or budget is somebody's data and is left alone.

Final state: `project_profiles=0  teams=0  departments=0  user_profiles=0` — identical to
the initial state.

## Known limitations

1. **Budget is always healthy.** `budgetTotal` and `budgetUsed` exist on the profile but
   nothing writes them, so a computed budget dimension would describe data that does not
   exist. It is the clearest candidate for an override until a real figure arrives.
2. **Capacity and allocation are not inputs**, for the reason given above: hours cannot be
   compared to a task count without an invented constant, and there is no project→team
   relationship. Revisit when estimates or Portfolio exist.
3. **No project due date.** `toEpmProject` passes `dueDate: undefined`, so the past-due
   escalation in `scope` can never fire in practice. The rule is implemented and tested;
   its input is not yet mapped from OpenProject.
4. **No team or department health.** No requirement asks for it and there is no
   relationship to aggregate through. Depends on Portfolio.
5. **No health history or trend.** Health is computed per request. "Was this project amber
   last month" has no answer — that is Analytics.
6. **No audit of who pinned what.** The override records the value, not the author or the
   time beyond `updatedAt`, and no reason can be attached to a pin.
7. **Thresholds are not configurable.** Named constants in the backend, deliberately — a
   configuration subsystem for five numbers nobody has asked to change would be cost
   without a reader.

## Future analytics requirements

Trended health, health-change history, per-dimension distributions over time, and
"projects that moved to critical this week" all need health stored per period rather than
computed per request. That is a snapshot table and a scheduled write — the `MetricSnapshot`
model already in the schema is the obvious precedent — and belongs to Analytics, not here.
