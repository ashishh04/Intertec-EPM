# EPM — Intertec Systems

**Unified Project & Delivery Platform.** A custom frontend that sits above a self-hosted
OpenProject instance and presents only the workflows Intertec Systems delivery teams need.

```
                    EPM
              Custom Frontend        ← this repository
                     │
                     ▼
              EPM Backend / BFF
                     │
                     ▼
          Self-Hosted OpenProject
```

The frontend never talks to OpenProject directly, never holds an OpenProject token, and knows
nothing about OpenProject's HAL payloads or database schema. It speaks only to the EPM backend,
which owns authentication, authorization, API credentials, transformation, pagination, caching,
webhooks, audit logging and rate limiting.

---

## Getting started

```bash
npm install
cp .env.example .env      # already committed as .env for local convenience
npm run dev               # http://localhost:5173
```

| Script            | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `npm run dev`     | Vite dev server with HMR                   |
| `npm run build`   | Type-check (`tsc -b`) then production build |
| `npm run preview` | Serve the production build locally         |
| `npm run lint`    | Type-check only                            |

### Environment

| Variable            | Default                     | Meaning                                                    |
| ------------------- | --------------------------- | ---------------------------------------------------------- |
| `VITE_API_BASE_URL` | `http://localhost:8000/api` | Base URL of the **EPM backend** — never an OpenProject URL |
| `VITE_APP_ENV`      | `development`               | Drives the environment badge in the header                  |

---

## Backend contract

Every domain has one interface in [`src/services/repositories.ts`](src/services/repositories.ts),
implemented by an `Api*Repository` against the EPM backend. The UI only ever sees the interface.

### Endpoints the backend must provide

Each `Api*Repository` in [`src/services/api/`](src/services/api/) is the contract:

| Resource      | Endpoints                                                                     |
| ------------- | ----------------------------------------------------------------------------- |
| Session       | `GET /me`                                                                     |
| Users         | `GET /users`, `GET /users/:id`                                                |
| Projects      | `GET /projects`, `GET /projects/:id`, `GET /projects/:id/milestones`, `PATCH /projects/:id` |
| Work packages | `GET /tasks`, `GET /tasks/:id`, `POST /tasks`, `PATCH /tasks/:id`, `PATCH /tasks/bulk`, `DELETE /tasks/bulk` |
| Comments      | `GET /tasks/:id/comments`, `POST /tasks/:id/comments`                         |
| Teams         | `GET /teams`, `GET /teams/:id`, `GET /teams/workloads`                        |
| Sprints       | `GET /sprints`, `GET /sprints/:id`, `GET /sprints/active`                     |
| Dashboard     | `GET /dashboard/metrics`, `GET /activity`, `GET /calendar/events`             |
| Reports       | `GET /reports/{delivery-trends,status-distribution,executive-insights,time-summary}` |
| Notifications | `GET /notifications`, `PATCH /notifications/read`, `PATCH /notifications/read-all` |
| Documents     | `GET /documents`, `POST /documents`                                           |
| Integration   | `GET /integrations/status`, `POST /integrations/status/sync`                  |

Responses must match the **normalized EPM models** in [`src/types/index.ts`](src/types/index.ts)
(`EpmProject`, `EpmTask`, `EpmSprint`, …). The backend adapter is responsible for mapping
OpenProject projects, work packages, principals, groups, memberships, versions, statuses,
priorities, relations, time entries and custom fields onto those shapes. Filtering, sorting and
pagination are server-side concerns — the frontend sends them as query parameters and never loads a
full dataset into the browser.

---

## Architecture

```
src/
  components/
    ui/          shadcn-style primitives on Radix (button, dialog, select, table, …)
    common/      cross-cutting product components (MetricCard, StatusBadge, EmptyState, …)
    layout/      AppShell, Sidebar, TopHeader, Breadcrumbs, CommandPalette, MobileNav
    tasks/       TaskRow, TaskTable, TaskWorkspace, TaskDrawer, FilterBar
    board/       KanbanBoard (dnd-kit)
    gantt/       GanttChart
    charts/      Recharts wrappers bound to the theme tokens
    dashboard/ teams/ documents/
  pages/         one file per route, lazily loaded
  hooks/         TanStack Query hooks — the only thing that calls a service
  services/
    repositories.ts   interfaces
    api/              ApiClient + Api*Repository
    index.ts          service facade
  types/         normalized EPM domain models
  lib/           utils, domain metadata (the status system), query keys
  providers/     Theme, Auth, UI (sidebar, palette, drawers)
  config/        env, navigation
```

**The data path is one-way:** `Component → Hook → Service → EPM API`. Components never call
`fetch`, never construct a repository and never reference `/api/v3/`.

### The status system

Every badge, board column, chart colour and table cell reads its label and tone from
[`src/lib/domain.ts`](src/lib/domain.ts). That single source is why status looks and reads
identically on the dashboard, the board, the Gantt and the reports. State is never communicated by
colour alone — badges carry a dot plus a word, priority renders a bar glyph, and health cells pair a
dot with an explicit label.

### Pagination

No screen renders an unbounded list — a growing dataset costs a page click, never an endless scroll.
Two mechanisms cover every collection:

- **Server-driven** — the work package tables ask the backend for one page at a time (`page` /
  `pageSize` on `TaskFilters`), so the browser never holds the whole task list. The rows-per-page
  control writes straight back into the query filters, which re-fetches.
- **Client-side** — [`usePagination`](src/hooks/usePagination.ts) slices an already-loaded
  collection: projects, teams, documents, notifications, My Work buckets, activity feeds, workload
  lists, Gantt rows and the report tables. It *clamps* instead of resetting when the current page
  runs past the end (deleting the last row on page 4 lands you on page 3, not page 1), and takes a
  `resetKey` so changing a filter or switching entity returns the reader to page 1.

Both render the same [`Pagination`](src/components/common/Pagination.tsx) control: first and last
page plus the current page's neighbours with an ellipsis for the gap, a `Showing 1–15 of 80 tasks`
summary, and an optional rows-per-page select. It renders nothing when everything already fits on
one page and the page size is not adjustable, so quiet screens stay quiet.

| Surface | Rows per page | Source |
| --- | --- | --- |
| Task tables (all work package views) | 15, adjustable to 25 / 50 / 100 | server |
| Projects grid / table | 12 / 15 | client |
| Teams, documents (workspace and per project) | 9 | client |
| Notifications, project activity | 15 | client |
| My Work (per urgency bucket), sprint history | 8 | client |
| Workload, team members, project members | 10 | client |
| Overdue work, billable summary, portfolio health matrix | 10 | client |
| Task comments | 10 | client |
| Gantt rows | 15 | client |

The board is the deliberate exception: paging cards would break drag-and-drop, so a Kanban column
renders 15 cards and then offers a `Show N more` button. The column header always reports the true
total, so a capped column never reads as an empty one.

### Real-time readiness

No fake WebSocket behaviour is implemented. [`src/lib/queryKeys.ts`](src/lib/queryKeys.ts)
centralizes every query key and groups them for invalidation, so a future SSE/WebSocket layer only
has to map an incoming event (`task.changed`, `project.updated`, `sprint.changed`,
`notification.received`) to `queryClient.invalidateQueries` against the right key.

---

## Security posture

- The frontend holds **no** OpenProject tokens, credentials or secrets, and cannot reach OpenProject.
- Sessions are issued by the EPM backend; `ApiClient` sends `credentials: 'include'` and nothing else.
- Only a non-sensitive "a session exists" marker is kept in `sessionStorage` so a refresh does not
  bounce the user to the login screen. No credentials are stored in `localStorage`.
- The `Permission` model (`view | create | edit | delete | admin`) drives whether UI actions are
  shown or disabled. **This is presentation only** — the real authorization boundary is the backend.
- The integration page shows connection health, never tokens.

---

## Not yet implemented

Several of these are intentional product decisions rather than oversights. Where a feature is
absent, the UI says so through a toast instead of faking success.

| Area | Status |
| --- | --- |
| **Authentication** | Stub — `signIn()` sets a `sessionStorage` marker; no real IdP. `AuthProvider` is the single seam to replace. |
| **Permissions** | Hardcoded to full delivery rights in `AuthProvider`. Needs `GET /me` to carry the caller's OpenProject permissions. |
| **"Ask EPM"** | Entry point renders; no AI responses are faked. |
| **Real-time** | Not implemented. Invalidation groups in `src/lib/queryKeys.ts` are ready for it. |
| **Write actions** | Project creation, sprint start/complete, time logging, member invite, messaging, document preview and inline task editing are toast stubs (13 sites — grep `not implemented yet`). |
| **Document upload** | No real file transfer; needs a backend endpoint and storage. |
| **Tests** | No unit or integration suite. Verification is typecheck, build, and a Playwright smoke pass over every route. |

When you implement one of these, replace the toast — don't leave both.

---

## Accessibility & responsiveness

- Semantic landmarks, a skip link, and a focusable `<main>`.
- Visible focus rings on every interactive element; the command palette (`Ctrl`/`⌘ K`) and task
  composer (`C`) are keyboard-driven.
- Dialogs, drawers, menus, selects and tooltips are Radix primitives with correct roles and focus
  management.
- Sortable table headers expose `aria-sort`; progress bars expose `role="progressbar"` with values.
- `prefers-reduced-motion` disables transitions and page animations.
- Desktop keeps a persistent sidebar, tablet collapses it, mobile uses a bottom navigation bar with
  44px touch targets and a centred create action. Wide content (tables, boards, timelines) scrolls
  inside its own region — the page body never scrolls horizontally.

## Dark mode

A separately authored dark palette (not an inversion) defined as tokens in
[`src/index.css`](src/index.css). The choice persists in `localStorage` and is applied before first
paint to avoid a flash of the wrong theme.
