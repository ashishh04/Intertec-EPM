import { Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/providers/AuthProvider';
import type { AppRole, Permission } from '@/types';
import { safeDestination } from '@/lib/navigation';
import { page } from '@/lib/pages';
import { isAdministrator, ROLE_ACCESS } from '@/config/navigation';

/**
 * Routes are code-split so the initial bundle only carries the shell and the
 * dashboard path. Heavier surfaces (Gantt, analytics, board) load on demand.
 * `page()` (lib/pages.ts) is `lazy()` that also lets the shell fetch every page
 * ahead of time once someone is signed in, and recovers after a deploy.
 */
const LandingPage = page(() => import('@/pages/LandingPage'));
const LoginPage = page(() => import('@/pages/LoginPage'));
const SetPasswordPage = page(() => import('@/pages/SetPasswordPage'));
const InvitePage = page(() => import('@/pages/InvitePage'));
const ForgotPasswordPage = page(() => import('@/pages/ForgotPasswordPage'));
const ResetPasswordPage = page(() => import('@/pages/ResetPasswordPage'));
const DashboardPage = page(() => import('@/pages/DashboardPage'));
const MyWorkPage = page(() => import('@/pages/MyWorkPage'));
const MyTimePage = page(() => import('@/pages/MyTimePage'));
const TimeCostsPage = page(() => import('@/pages/TimeCostsPage'));
const ProjectsPage = page(() => import('@/pages/ProjectsPage'));
const ProjectDetailPage = page(() => import('@/pages/project/ProjectDetailPage'));
const ProjectOverviewTab = page(() => import('@/pages/project/ProjectOverviewTab'));
const ProjectTasksTab = page(() => import('@/pages/project/ProjectTasksTab'));
const ProjectBoardTab = page(() => import('@/pages/project/ProjectBoardTab'));
const ProjectSprintTab = page(() => import('@/pages/project/ProjectSprintTab'));
const ProjectGanttTab = page(() => import('@/pages/project/ProjectGanttTab'));
const ProjectTeamTab = page(() => import('@/pages/project/ProjectTeamTab'));
const ProjectDocumentsTab = page(() => import('@/pages/project/ProjectDocumentsTab'));
const ProjectMeetingsTab = page(() => import('@/pages/project/ProjectMeetingsTab'));
const ProjectNewsTab = page(() => import('@/pages/project/ProjectNewsTab'));
const ProjectWikiTab = page(() => import('@/pages/project/ProjectWikiTab'));
const ProjectActivityTab = page(() => import('@/pages/project/ProjectActivityTab'));
const ProjectReportsTab = page(() => import('@/pages/project/ProjectReportsTab'));
const ProjectDashboardTab = page(() => import('@/pages/project/ProjectDashboardTab'));
const ProjectRoadmapTab = page(() => import('@/pages/project/ProjectRoadmapTab'));
const ProjectBacklogTab = page(() => import('@/pages/project/ProjectBacklogTab'));
const ProjectSettingsTab = page(() => import('@/pages/project/ProjectSettingsTab'));
const TasksPage = page(() => import('@/pages/TasksPage'));
const TaskDetailPage = page(() => import('@/pages/TaskDetailPage'));
const TeamsPage = page(() => import('@/pages/TeamsPage'));
const DepartmentsPage = page(() => import('@/pages/DepartmentsPage'));
const EmployeesPage = page(() => import('@/pages/EmployeesPage'));
const PortfoliosPage = page(() => import('@/pages/PortfoliosPage'));
const PortfolioDetailPage = page(() => import('@/pages/PortfolioDetailPage'));
const ProgramsPage = page(() => import('@/pages/ProgramsPage'));
const ProgramDetailPage = page(() => import('@/pages/ProgramDetailPage'));
const ProjectRequestsPage = page(() => import('@/pages/ProjectRequestsPage'));
const ProjectRequestDetailPage = page(() => import('@/pages/ProjectRequestDetailPage'));
const StageGateReviewPage = page(() => import('@/pages/StageGateReviewPage'));
const DepartmentDetailPage = page(() => import('@/pages/DepartmentDetailPage'));
const TeamDetailPage = page(() => import('@/pages/TeamDetailPage'));
const CalendarPage = page(() => import('@/pages/CalendarPage'));
const AgilePage = page(() => import('@/pages/AgilePage'));
const BoardsPage = page(() => import('@/pages/BoardsPage'));
const SprintsPage = page(() => import('@/pages/SprintsPage'));
const GanttPage = page(() => import('@/pages/GanttPage'));
const MilestonesPage = page(() => import('@/pages/MilestonesPage'));
const RisksPage = page(() => import('@/pages/RisksPage'));
const ResourcesPage = page(() => import('@/pages/ResourcesPage'));
const TimesheetsPage = page(() => import('@/pages/TimesheetsPage'));
const TimesheetPage = page(() => import('@/pages/TimesheetPage'));
const ExpensesPage = page(() => import('@/pages/ExpensesPage'));
const FinancePage = page(() => import('@/pages/FinancePage'));
const ScenariosPage = page(() => import('@/pages/ScenariosPage'));
const ForecastsPage = page(() => import('@/pages/ForecastsPage'));
const ScenarioPage = page(() => import('@/pages/ScenarioPage'));
const ExpenseClaimPage = page(() => import('@/pages/ExpenseClaimPage'));
const ReportsPage = page(() => import('@/pages/ReportsPage'));
const InsightsPage = page(() => import('@/pages/InsightsPage'));
const ScheduledReportsPage = page(() => import('@/pages/ScheduledReportsPage'));
const PortfolioViewsPage = page(() => import('@/pages/PortfolioViewsPage'));
const PortfolioViewPage = page(() => import('@/pages/PortfolioViewPage'));
const AnalyticsPage = page(() => import('@/pages/AnalyticsPage'));
const JournalPage = page(() => import('@/pages/JournalPage'));
const DocumentsPage = page(() => import('@/pages/DocumentsPage'));
const MeetingsPage = page(() => import('@/pages/MeetingsPage'));
const MeetingDetailPage = page(() => import('@/pages/MeetingDetailPage'));
const NewsPage = page(() => import('@/pages/NewsPage'));
const WikiPage = page(() => import('@/pages/WikiPage'));
const NotificationsPage = page(() => import('@/pages/NotificationsPage'));
const ApprovalsPage = page(() => import('@/pages/ApprovalsPage'));
const ApprovalDecidePage = page(() => import('@/pages/ApprovalDecidePage'));
const ProfilePage = page(() => import('@/pages/ProfilePage'));
const SettingsPage = page(() => import('@/pages/SettingsPage'));
const IntegrationPage = page(() => import('@/pages/IntegrationPage'));
const NotFoundPage = page(() => import('@/pages/NotFoundPage'));
const ForbiddenPage = page(() => import('@/pages/ForbiddenPage'));
const MfaSetupPage = page(() => import('@/pages/MfaSetupPage'));
const AdministrationPage = page(() => import('@/pages/admin/AdministrationPage'));
const PortalApp = page(() => import('@/pages/portal/PortalApp'));

/**
 * Boundary for the routes that render outside AppShell — in practice /login.
 * AppShell has its own Suspense around its outlet, so every protected page was
 * covered; the sign-in page was not, and a lazy component with no boundary
 * above it takes the tree down to a blank page rather than a loading state.
 *
 * A plain background rather than a skeleton: the chunk is small and local, and
 * outlining a form that is about to appear reads as breakage.
 */
function RouteFallback() {
  return <div className="min-h-screen bg-background" />;
}

/**
 * Where an already-signed-in visitor to /login belongs.
 *
 * Not always the dashboard. A deep link or a browser refresh lands here for a
 * moment whenever the session has not been confirmed yet — RequireAuth sends
 * anyone it cannot vouch for to /login and records where they were going — and
 * answering "the dashboard" threw that destination away, so every refresh
 * became a trip home.
 */
function SignedInRedirect() {
  const location = useLocation();
  const from = (location.state as { from?: unknown } | null)?.from;
  return <Navigate to={safeDestination(from)} replace />;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, mustChangePassword, mfaSetupRequired, external } = useAuth();
  const location = useLocation();

  // The session is confirmed with the backend, so it is not known on first
  // paint. Deciding before it resolves would bounce every deep link and every
  // refresh to /login, and from there to the dashboard — losing the
  // destination the user actually asked for.
  if (isLoading) return null;

  if (!isAuthenticated) {
    // The query string travels too: an approval link's chosen decision is in
    // it, and losing it on the way through sign-in would lose the person's choice.
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  // Held at the door. Rendered in place of the route rather than redirected to
  // one, so there is no address to skip past and no destination to lose — the
  // requested URL is still there once the password is set.
  if (mustChangePassword) return <SetPasswordPage />;

  // Likewise, where their role requires two-factor authentication and they have
  // not set it up. After the password, so the app they register is set up by
  // someone holding a password of their own.
  if (mfaSetupRequired) return <MfaSetupPage />;

  // An external user (BR-611) sees the portal in place of EPM, whatever the address;
  // the server refuses them everything else anyway.
  if (external) return <PortalApp />;

  return <>{children}</>;
}

/**
 * Routes behind a permission, and Administration. The sidebar already hides
 * these links from anyone without the permission; this is what makes a typed
 * or shared URL honour the same rule. Rendered in place, like the password
 * gate, so the address stays put and explains itself.
 */
function RequirePermission({
  permission,
  children,
}: {
  /** A specific permission, or `administrator` for anyone who administers anything. */
  permission: Permission | 'administrator';
  children: React.ReactNode;
}) {
  const { can } = useAuth();
  const allowed = permission === 'administrator' ? isAdministrator(can) : can(permission);
  // Only Administration is for administrators. A permission may come with a
  // Manager's or HR's role or be granted to anyone, so its refusal says the
  // person's access does not include the area.
  if (!allowed) return <ForbiddenPage reason={permission === 'administrator' ? 'administrator' : 'permission'} />;
  return <>{children}</>;
}

/**
 * Areas that belong to some roles only (ROLE_ACCESS). The sidebar hides them
 * from everyone else; this refuses the typed or bookmarked address the same way.
 */
function RequireRole({ roles, children }: { roles: readonly AppRole[]; children: React.ReactNode }) {
  const { role } = useAuth();
  if (!roles.includes(role)) return <ForbiddenPage reason="role" />;
  return <>{children}</>;
}

export function App() {
  const { isAuthenticated, isLoading } = useAuth();

  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route
          path="/"
          // The public entry point. Someone already signed in has no use for
          // the pitch, so they go straight to their work.
          element={
            isLoading ? null : isAuthenticated ? (
              <Navigate to="/dashboard" replace />
            ) : (
              <LandingPage />
            )
          }
        />

        <Route
          path="/login"
          // Same reason as RequireAuth: show nothing until the session is known,
          // rather than flashing the sign-in form at someone already signed in.
          element={isLoading ? null : isAuthenticated ? <SignedInRedirect /> : <LoginPage />}
        />

        {/* Public, and shown whatever the session state: the person arriving
            here has no password yet, and an administrator testing the link
            should see what they will see. */}
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password/:token" element={<ResetPasswordPage />} />

        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/my-work" element={<MyWorkPage />} />
          {/* Time tracking is two surfaces, not one: your own week, which you
              edit, and the organisation's hours, which you read. Neither is
              permission-gated here — OpenProject scopes both to what the caller
              may see, per project. The organisation's hours are a reporting
              screen, so they follow the role (managers and HR), not a permission. */}
          <Route path="/my-time" element={<MyTimePage />} />
          <Route
            path="/time-and-costs"
            element={
              <RequireRole roles={ROLE_ACCESS.reporting}>
                <TimeCostsPage />
              </RequireRole>
            }
          />

          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />}>
            <Route index element={<ProjectOverviewTab />} />
            <Route path="dashboard" element={<ProjectDashboardTab />} />
            <Route path="backlog" element={<ProjectBacklogTab />} />
            <Route path="roadmap" element={<ProjectRoadmapTab />} />
            <Route path="settings" element={<ProjectSettingsTab />} />
            <Route path="tasks" element={<ProjectTasksTab />} />
            <Route path="board" element={<ProjectBoardTab />} />
            <Route path="sprint" element={<ProjectSprintTab />} />
            <Route path="gantt" element={<ProjectGanttTab />} />
            <Route path="team" element={<ProjectTeamTab />} />
            <Route path="documents" element={<ProjectDocumentsTab />} />
            <Route path="meetings" element={<ProjectMeetingsTab />} />
            <Route path="news" element={<ProjectNewsTab />} />
            <Route path="wiki" element={<ProjectWikiTab />} />
            <Route path="activity" element={<ProjectActivityTab />} />
            <Route path="reports" element={<ProjectReportsTab />} />
          </Route>

          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />

          <Route
            path="/departments"
            element={
              <RequirePermission permission="departments:manage">
                <DepartmentsPage />
              </RequirePermission>
            }
          />
          {/* Gated like the directory above it: a department is EPM's own
              record, and everything on this page is drawn from the same
              reads the directory already needs that permission for. */}
          <Route
            path="/departments/:departmentId"
            element={
              <RequirePermission permission="departments:manage">
                <DepartmentDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="/employees"
            element={
              <RequirePermission permission="employees:manage">
                <EmployeesPage />
              </RequirePermission>
            }
          />
          <Route
            path="/journal"
            element={
              <RequirePermission permission="audit:view">
                <JournalPage />
              </RequirePermission>
            }
          />
          <Route
            path="/portfolios"
            element={
              <RequirePermission permission="portfolios:manage">
                <PortfoliosPage />
              </RequirePermission>
            }
          />
          {/* Not gated like the directory above it. A project's overview links
              here for anyone who can see that project, and the backend serves
              the read to anyone who can see a project in it — gating it would
              refuse a member who simply clicked the portfolio their project is
              in. The page still checks `portfolios:manage` before offering edit
              or archive. */}
          <Route path="/portfolios/:portfolioId" element={<PortfolioDetailPage />} />
          {/* Programs: the list is for managers; one opens for anyone who can see a project in it. */}
          <Route
            path="/programs"
            element={
              <RequireRole roles={ROLE_ACCESS.insights}>
                <ProgramsPage />
              </RequireRole>
            }
          />
          <Route path="/programs/:programId" element={<ProgramDetailPage />} />
          {/* Requests to start a project, and gate reviews: each opens for those involved. */}
          <Route path="/project-requests" element={<ProjectRequestsPage />} />
          <Route path="/project-requests/:requestId" element={<ProjectRequestDetailPage />} />
          <Route path="/stage-gate-reviews/:reviewId" element={<StageGateReviewPage />} />
          {/* Saved portfolio views (BR-203). The list is for managers; a single view
              opens for anyone it was shared with, showing only the projects they
              may read, and the backend refuses a view not shared with them. */}
          <Route
            path="/portfolio-views"
            element={
              <RequireRole roles={ROLE_ACCESS.insights}>
                <PortfolioViewsPage />
              </RequireRole>
            }
          />
          <Route path="/portfolio-views/:viewId" element={<PortfolioViewPage />} />

          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/teams/:teamId" element={<TeamDetailPage />} />

          <Route path="/calendar" element={<CalendarPage />} />
          <Route
            path="/agile"
            element={
              <RequireRole roles={ROLE_ACCESS.delivery}>
                <AgilePage />
              </RequireRole>
            }
          />
          <Route
            path="/boards"
            element={
              <RequireRole roles={ROLE_ACCESS.delivery}>
                <BoardsPage />
              </RequireRole>
            }
          />
          <Route
            path="/sprints"
            element={
              <RequireRole roles={ROLE_ACCESS.delivery}>
                <SprintsPage />
              </RequireRole>
            }
          />
          <Route
            path="/gantt"
            element={
              <RequireRole roles={ROLE_ACCESS.delivery}>
                <GanttPage />
              </RequireRole>
            }
          />
          {/* Every project's milestones on one timeline, and the risk register.
              Both list only what the person may read; the backend scopes them. */}
          <Route
            path="/milestones"
            element={
              <RequireRole roles={ROLE_ACCESS.delivery}>
                <MilestonesPage />
              </RequireRole>
            }
          />
          <Route
            path="/risks"
            element={
              <RequireRole roles={ROLE_ACCESS.delivery}>
                <RisksPage />
              </RequireRole>
            }
          />
          <Route path="/resources" element={<ResourcesPage />} />
          {/* Timesheets and expense claims (Module 10). Everyone has their own;
              who may read more is the backend's decision. */}
          <Route path="/timesheets" element={<TimesheetsPage />} />
          <Route path="/timesheets/people/:personId" element={<TimesheetPage />} />
          <Route path="/timesheets/:id" element={<TimesheetPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route
            path="/forecasts"
            element={
              <RequireRole roles={ROLE_ACCESS.insights}>
                <ForecastsPage />
              </RequireRole>
            }
          />
          <Route
            path="/scenarios"
            element={
              <RequirePermission permission="scenarios:manage">
                <ScenariosPage />
              </RequirePermission>
            }
          />
          <Route
            path="/scenarios/:id"
            element={
              <RequirePermission permission="scenarios:manage">
                <ScenarioPage />
              </RequirePermission>
            }
          />
          <Route
            path="/finance"
            element={
              <RequirePermission permission="finance:view">
                <FinancePage />
              </RequirePermission>
            }
          />
          <Route path="/expenses/:id" element={<ExpenseClaimPage />} />

          {/* The executive and PMO dashboards (BR-405), for managers. Every figure is
              scoped server-side to the projects the person can read. A single
              dashboard stays open to anyone it was shared with. */}
          <Route
            path="/insights"
            element={
              <RequireRole roles={ROLE_ACCESS.insights}>
                <InsightsPage />
              </RequireRole>
            }
          />
          <Route path="/insights/:dashboardId" element={<InsightsPage />} />
          <Route
            path="/reports"
            element={
              <RequireRole roles={ROLE_ACCESS.reporting}>
                <ReportsPage />
              </RequireRole>
            }
          />
          {/* Scheduled distribution (BRQ-08). The backend refuses its endpoints
              without `reports:schedule` too; this gate keeps the page honest. */}
          <Route
            path="/reports/scheduled"
            element={
              <RequirePermission permission="reports:schedule">
                <ScheduledReportsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/analytics"
            element={
              <RequirePermission permission="analytics:manage">
                <AnalyticsPage />
              </RequirePermission>
            }
          />
          <Route path="/documents" element={<DocumentsPage />} />
          {/* Collaboration. Not permission-gated here: each record is scoped to a
              project and the backend answers per record from OpenProject's own
              view of who may see that project — a gate in front of the route
              would refuse people the instance would have answered. */}
          <Route path="/meetings" element={<MeetingsPage />} />
          <Route path="/meetings/:meetingId" element={<MeetingDetailPage />} />
          <Route path="/news" element={<NewsPage />} />
          {/* The slug is a path segment so a wiki link reads as a link. The
              bare path opens whichever page the wiki starts with. */}
          <Route path="/wiki" element={<WikiPage />} />
          <Route path="/wiki/:slug" element={<WikiPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          {/* Where an approval email's links land: it shows the request, and the person confirms. */}
          <Route path="/approvals/decide/:token" element={<ApprovalDecidePage />} />
          <Route path="/profile" element={<ProfilePage />} />
          {/*
            One component for the whole of Administration: it reads the area
            and page from the URL and does its own routing, redirects and
            not-found handling, so the three paths share one guard.
          */}
          {['/admin', '/admin/:areaId', '/admin/:areaId/:pageId', '/admin/:areaId/:pageId/:itemId'].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <RequirePermission permission="administrator">
                  <AdministrationPage />
                </RequirePermission>
              }
            />
          ))}
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="/settings/integration"
            element={
              <RequirePermission permission="users:manage">
                <IntegrationPage />
              </RequirePermission>
            }
          />

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
