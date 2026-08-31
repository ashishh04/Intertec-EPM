# NEXUS Frontend — Handoff

Written for the next engineer or agent picking this up. It describes **what exists, why it is
shaped this way, what is deliberately not built, and the rules that must not be broken.**
For architecture detail and the backend endpoint contract, read [README.md](README.md) as well.

---

## 1. What this is

NEXUS is Intertec Systems' internal project and delivery platform: a **custom frontend over a
self-hosted OpenProject backend**. It is explicitly *not* an OpenProject skin — OpenProject is the
system of record, NEXUS is the product surface.

The critical architectural fact:

```
Browser (this app)  →  Nexus backend (BFF)  →  OpenProject API
```

The frontend **never** talks to OpenProject. It has no OpenProject URL, no API token, no
credentials, and no knowledge of `/api/v3/`. The backend owns that boundary and returns
**normalized Nexus models** (`NexusProject`, `NexusTask`, …), not raw OpenProject payloads.

Current state: **complete, self-contained frontend running on bundled demo data.** Every screen is
built, typed, and renders without errors. No backend is required to run it.

---

## 2. Run it

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
npm run build        # tsc -b && vite build
npm run lint         # tsc --noEmit
npm run preview      # serves dist/ on :4173
```

No `.env` edit is needed — it defaults to demo data.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:8000/api` | Base URL of the **Nexus backend** — never an OpenProject URL |
| `VITE_DATA_SOURCE` | `mock` | `mock` = bundled demo data, `api` = live backend |
| `VITE_APP_ENV` | `demo` | Drives the environment badge in the header |

---

## 3. Stack

| Concern | Choice |
| --- | --- |
| Build | Vite 6, TypeScript 5.7 (strict), path alias `@/*` → `src/*` |
| UI | React 18, Tailwind 3, shadcn-style primitives hand-written on Radix |
| Icons / motion | lucide-react, Framer Motion |
| Server state | TanStack Query v5 |
| Routing | React Router 6, route-level `React.lazy` |
| Forms | react-hook-form + zod |
| Charts | Recharts, bound to CSS-variable theme colours |
| Drag & drop | @dnd-kit |
| Command palette | cmdk |
| Toasts | sonner |
| Dates | date-fns v4 |

> `react-day-picker` is deliberately **absent** — v8 peer-requires date-fns 2/3 and conflicts with
> date-fns 4. The calendar is hand-built on date-fns. Do not add it back.

~129 TS/TSX files, ~17.5k lines, 31 pages, 55 components, 14 hooks.

---

## 4. The one rule that keeps this maintainable

```
Component  →  Hook  →  Service (repository)  →  Nexus API
```

- Components never call `fetch`, never construct a repository, never reference an endpoint path.
- Hooks in `src/hooks/` are the **only** things that touch a service.
- Every domain has one interface with two implementations, and the UI only ever sees the interface:

```
ProjectRepository              src/services/repositories.ts
   ├── MockProjectRepository   src/services/mock/
   └── ApiProjectRepository    src/services/api/
```

**Going live is one switch**, no component changes:

```bash
VITE_DATA_SOURCE=api
VITE_API_BASE_URL=https://nexus-api.internal/api
```

Deleting `src/mocks/` removes all demo data in one place — nothing outside `src/services/mock/`
imports from it. The endpoint contract the backend must satisfy is tabulated in
[README.md](README.md#endpoints-the-backend-must-provide); each `Api*Repository` **is** the spec.

---

## 5. Directory map

```
src/
  components/
    ui/          Radix-based primitives (button, dialog, select, table, sheet, command, …)
    common/      cross-cutting product parts (MetricCard, StatusBadge, EmptyState, ErrorState,
                 QueryBoundary, Pagination, PageHeader, UserAvatar, ActivityTimeline, ChartCard)
    layout/      AppShell, Sidebar, TopHeader, Breadcrumbs, CommandPalette, MobileNav
    tasks/       TaskRow, TaskTable, TaskWorkspace, TaskDrawer, FilterBar
    board/       KanbanBoard (dnd-kit)
    gantt/       GanttChart
    charts/      Recharts wrappers bound to theme tokens
    dashboard/ teams/ documents/
  pages/         one file per route, lazily loaded (pages/project/* are the 9 detail tabs)
  hooks/         TanStack Query hooks — the only layer that calls a service
  services/      repositories.ts (interfaces) + api/ + mock/ + index.ts (picks by VITE_DATA_SOURCE)
  types/         43 normalized Nexus domain models
  mocks/         the entire demo dataset, isolated in one file
  lib/           utils.ts, domain.ts (the status system), queryKeys.ts
  providers/     Auth, Theme, UI (sidebar / palette / drawer state)
  config/        env.ts, navigation.ts
```

---

## 6. What is built

### Routes

| Route | Contents |
| --- | --- |
| `/login` | SSO-style sign-in screen (stubbed — see §10) |
| `/dashboard` | Greeting, 6 metric cards, delivery trend, status split, my tasks, at-risk projects, activity feed |
| `/my-work` | Personal queue split into Overdue / Today / Upcoming / Recently completed, each paged |
| `/projects` | Grid + table views, search, status and portfolio filters |
| `/projects/:id` | Detail shell with 9 tabs → `index` (overview), `tasks`, `board`, `sprint`, `gantt`, `team`, `documents`, `activity`, `reports` |
| `/tasks` | Full work package workspace: filter bar, sortable columns, column visibility, bulk actions, server-side paging |
| `/tasks/:id` | Task detail: description, comments, activity, sidebar of properties, status/priority controls |
| `/teams`, `/teams/:id` | Team directory and team workspace (overview, members, projects, workload, activity) |
| `/calendar` | Month / week / day views over tasks and milestones |
| `/agile` | Sprint workspace: metrics, burndown, sprint board, sprint switcher |
| `/boards` | Kanban board with drag-and-drop between statuses |
| `/sprints` | Sprint history and velocity trend |
| `/gantt` | Timeline with dependencies, milestone lane, today marker, zoom, auto-scroll to today |
| `/reports` | 7 report tabs (status, completion, velocity, team, overdue, time, trends) |
| `/analytics` | Executive "Delivery Intelligence": portfolio health matrix, risk cards, KPI strip |
| `/documents` | Document library, 4 tabs, upload affordance |
| `/notifications` | Notification centre with category filters and read/read-all |
| `/profile`, `/settings`, `/settings/integration` | Profile, settings (Nexus-owned vs OpenProject-owned clearly separated), OpenProject connection status |
| `*` | 404 |

### Cross-cutting behaviour

- **Command palette** — ⌘K / Ctrl+K, fuzzy across projects, tasks, people, navigation.
- **Keyboard** — `c` opens the task composer anywhere.
- **Task composer** — react-hook-form + zod validation in a side drawer.
- **Dark mode** — a separately authored dark palette, not an inverted light one. Persisted.
- **Responsive** — desktop / tablet / mobile with a bottom nav and 44px touch targets. No
  horizontal page overflow at 390px (asserted in the smoke test).
- **States** — every async surface has loading skeleton, error with retry (`QueryBoundary`), and a
  purposeful empty state.
- **Sidebar** — collapsible 260px ↔ 72px, state persisted.

### The status system — read this before adding any badge

Every label, tone, board column, chart colour and health cell reads from
[`src/lib/domain.ts`](src/lib/domain.ts) (`TASK_STATUS_META`, `TASK_PRIORITY_META`,
`PROJECT_STATUS_META`, `HEALTH_META`, `TONE_*`). That single source is why status looks identical on
the dashboard, the board, the Gantt and the reports. **Do not hard-code a status label or colour
anywhere.** State is never conveyed by colour alone — badges pair a dot with a word, priority uses a
bar glyph, health cells carry an explicit label.

### Pagination

Nothing renders an unbounded list; a growing dataset costs a page click, never an endless scroll.

- **Server-driven** — task tables send `page`/`pageSize` in `TaskFilters`; the browser never holds
  the full task list.
- **Client-side** — [`usePagination`](src/hooks/usePagination.ts) slices loaded collections. It
  *clamps* rather than resets when the page runs past the end, and takes a `resetKey` so changing a
  filter returns to page 1.
- Both render [`Pagination`](src/components/common/Pagination.tsx) — summary line, first/last plus
  neighbours with an ellipsis, optional rows-per-page. It hides itself when everything fits.
- The board is the deliberate exception: paging cards would break drag-and-drop, so a Kanban column
  renders 15 cards then offers `Show N more`, with the header showing the true total.

Page sizes per surface are tabulated in [README.md](README.md#pagination).

---

## 7. Data layer

- [`src/lib/queryKeys.ts`](src/lib/queryKeys.ts) centralizes **every** query key and groups them for
  invalidation. Add new keys there, never inline.
- Mutation hooks that exist and already invalidate correctly:
  `useCreateTask`, `useUpdateTask`, `useBulkUpdateTasks`, `useDeleteTasks`, `useUpdateProject`,
  `useUploadDocument`, `useMarkNotificationsRead`, `useMarkAllNotificationsRead`, `useTriggerSync`.
- **Real-time readiness** — no fake WebSocket behaviour is implemented. A future SSE/WebSocket layer
  only has to map an incoming event (`task.changed`, `project.updated`, `sprint.changed`,
  `notification.received`) onto `queryClient.invalidateQueries` against the right key group.
  `featureFlags.realtime` in [`src/config/env.ts`](src/config/env.ts) is reserved for it.

---

## 8. Security rules — do not relax these

These were explicit product constraints. Preserve them in any future change.

1. **No OpenProject tokens, credentials or secrets in frontend code, env files, or bundles.** The
   frontend cannot reach OpenProject and must not be given a way to.
2. **No direct database access**, ever.
3. **No hard-coded API calls inside components** — the repository layer exists precisely to prevent
   this.
4. **No sensitive credentials in `localStorage`.** The only client-side session artefact is a
   non-sensitive `nexus.session` marker in `sessionStorage` so a refresh doesn't bounce the user to
   login. Real auth is an HTTP-only cookie issued by the backend; `ApiClient` already sends
   `credentials: 'include'`.
5. **Frontend permission checks are UX, never the security boundary.** `can(permission)` hides
   controls; the backend must independently authorize every request.
6. **`/settings/integration` never displays a token.** It shows connection state, last sync, and
   resource counts only. Administrators only.
7. **No real employee names, photographs, or real organizational data** — the demo dataset is
   fictional by design (see §9).

---

## 9. Demo data

`src/mocks/data.ts` is a single deterministic, **fictional** dataset: 14 people, 9 projects, 6
teams, 80 work packages, 3 sprints, 16 documents, notifications and activity. Names, avatars (initials
only — no photographs), and project names are invented. Sprint composition is derived from the
tasks themselves (`fillSprint`, `sprintPoints`) so committed/completed points always reconcile with
the board — if you change task data, the sprint numbers follow automatically.

The mock repositories emulate real backend behaviour: server-side filtering, sorting, pagination,
and artificial latency. That is what makes the `mock → api` switch a no-op for the UI.

---

## 10. What is deliberately NOT implemented

Be careful here — several of these are intentional product decisions, not oversights.

| Area | Status | Why |
| --- | --- | --- |
| **Authentication** | Stub. `signIn()` sets a `sessionStorage` marker; no real IdP. | Real SSO belongs to the backend. `AuthProvider` is the single seam to replace. |
| **"Ask Nexus"** | Entry point renders; **no AI responses are faked.** | Explicit constraint: never fake AI. Wire it to a real backend endpoint or leave it. |
| **Real-time** | Not implemented, no fake sockets. | Invalidation groups are ready for it (§7). |
| **Inline task editing** | Toast placeholder on `/tasks/:id`. | Needs the backend PATCH contract settled. |
| **Project creation, sprint start/complete, time logging, member invite, messaging, document preview** | Toast placeholders (12 sites — grep `not enabled in the demo`). | Deliberately honest stubs rather than fake success. |
| **Document upload** | Calls `useUploadDocument` against the mock store; no real file transfer. | Backend endpoint + storage required. |
| **Tests** | No unit/integration test suite. | Verification has been build + typecheck + a Playwright smoke script (§11). |

When you implement one of these, **replace the toast** — don't leave both.

---

## 11. How this has been verified

There is no test suite yet. The working loop has been:

```bash
npx tsc -p tsconfig.app.json --noEmit    # types
npm run build                            # production build
# then a Playwright smoke script over all 29 routes:
#   - console errors and page errors captured per route
#   - empty-main and error-boundary detection
#   - interactions: Ctrl+K palette, "c" composer, form validation
#   - dark mode, mobile 390px (horizontal-overflow assertion), tablet 834px
```

**Current status: typecheck clean, build clean, all 29 routes render with zero console or page
errors.** Bundle ≈ 1.7 MB across split chunks (`vendor-react`, `vendor-charts`, `vendor-motion`,
`vendor-dnd` + per-route chunks).

Recommended first infrastructure task: promote that smoke script into the repo as a real Playwright
suite so the next agent has a regression net.

---

## 12. Conventions to match

- **Match the surrounding code.** Comment density is low and explanatory — comments say *why*, never
  *what*. Keep it that way.
- Components are function declarations, props typed via an `interface` above the component.
- Tailwind classes composed with `cn()`; variants via `class-variance-authority`.
- Use the design tokens (`--nexus-primary`, `bg-surface`, `text-muted-foreground`, `shadow-card`,
  `text-2xs`, `ease-swift`), never raw hex.
- Numbers are `font-mono tabular-nums`.
- Every new async surface gets loading + error + empty states via `QueryBoundary`.
- Every new list gets pagination (`usePagination` + `Pagination`) before it can grow.
- New icons come from lucide-react only.
- Accessibility: label every icon-only button, keep 44px touch targets, never convey state by colour
  alone, and keep focus rings.

---

## 13. Suggested next steps, in order

1. **Stand up the Nexus backend (BFF)** against the contract in
   [README.md](README.md#endpoints-the-backend-must-provide). Start with `GET /me`, `/projects`,
   `/tasks` — that lights up most of the app.
2. **Flip one domain at a time** to `VITE_DATA_SOURCE=api` and diff behaviour against mock.
3. **Real authentication** — replace `AuthProvider`'s session marker with the backend session, and
   derive `permissions` from the server rather than the hard-coded PM set.
4. **Promote the smoke script into a committed Playwright suite**, then add unit tests for
   `lib/utils.ts`, `lib/domain.ts` and `usePagination`.
5. **Replace demo stubs** (§10) as backend capability lands, deleting each toast as you go.
6. **Wire "Ask Nexus"** to a real endpoint — or remove the entry point. Do not fake it.
7. **Real-time invalidation** via SSE/WebSocket using the existing key groups.
