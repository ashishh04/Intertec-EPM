import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/providers/AuthProvider';
import type { Permission } from '@/types';
import { safeDestination } from '@/lib/navigation';
import { isAdministrator } from '@/config/navigation';

/**
 * Routes are code-split so the initial bundle only carries the shell and the
 * dashboard path. Heavier surfaces (Gantt, analytics, board) load on demand.
 */
const LandingPage = lazy(() => import('@/pages/LandingPage'));
const LoginPage = lazy(() => import('@/pages/LoginPage'));
const SetPasswordPage = lazy(() => import('@/pages/SetPasswordPage'));
const InvitePage = lazy(() => import('@/pages/InvitePage'));
const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const MyWorkPage = lazy(() => import('@/pages/MyWorkPage'));
const MyTimePage = lazy(() => import('@/pages/MyTimePage'));
const TimeCostsPage = lazy(() => import('@/pages/TimeCostsPage'));
const ProjectsPage = lazy(() => import('@/pages/ProjectsPage'));
const ProjectDetailPage = lazy(() => import('@/pages/project/ProjectDetailPage'));
const ProjectOverviewTab = lazy(() => import('@/pages/project/ProjectOverviewTab'));
const ProjectTasksTab = lazy(() => import('@/pages/project/ProjectTasksTab'));
const ProjectBoardTab = lazy(() => import('@/pages/project/ProjectBoardTab'));
const ProjectSprintTab = lazy(() => import('@/pages/project/ProjectSprintTab'));
const ProjectGanttTab = lazy(() => import('@/pages/project/ProjectGanttTab'));
const ProjectTeamTab = lazy(() => import('@/pages/project/ProjectTeamTab'));
const ProjectDocumentsTab = lazy(() => import('@/pages/project/ProjectDocumentsTab'));
const ProjectMeetingsTab = lazy(() => import('@/pages/project/ProjectMeetingsTab'));
const ProjectNewsTab = lazy(() => import('@/pages/project/ProjectNewsTab'));
const ProjectWikiTab = lazy(() => import('@/pages/project/ProjectWikiTab'));
const ProjectActivityTab = lazy(() => import('@/pages/project/ProjectActivityTab'));
const ProjectReportsTab = lazy(() => import('@/pages/project/ProjectReportsTab'));
const TasksPage = lazy(() => import('@/pages/TasksPage'));
const TaskDetailPage = lazy(() => import('@/pages/TaskDetailPage'));
const TeamsPage = lazy(() => import('@/pages/TeamsPage'));
const DepartmentsPage = lazy(() => import('@/pages/DepartmentsPage'));
const EmployeesPage = lazy(() => import('@/pages/EmployeesPage'));
const PortfoliosPage = lazy(() => import('@/pages/PortfoliosPage'));
const PortfolioDetailPage = lazy(() => import('@/pages/PortfolioDetailPage'));
const DepartmentDetailPage = lazy(() => import('@/pages/DepartmentDetailPage'));
const TeamDetailPage = lazy(() => import('@/pages/TeamDetailPage'));
const CalendarPage = lazy(() => import('@/pages/CalendarPage'));
const AgilePage = lazy(() => import('@/pages/AgilePage'));
const BoardsPage = lazy(() => import('@/pages/BoardsPage'));
const SprintsPage = lazy(() => import('@/pages/SprintsPage'));
const GanttPage = lazy(() => import('@/pages/GanttPage'));
const ReportsPage = lazy(() => import('@/pages/ReportsPage'));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'));
const DocumentsPage = lazy(() => import('@/pages/DocumentsPage'));
const MeetingsPage = lazy(() => import('@/pages/MeetingsPage'));
const MeetingDetailPage = lazy(() => import('@/pages/MeetingDetailPage'));
const NewsPage = lazy(() => import('@/pages/NewsPage'));
const WikiPage = lazy(() => import('@/pages/WikiPage'));
const NotificationsPage = lazy(() => import('@/pages/NotificationsPage'));
const ProfilePage = lazy(() => import('@/pages/ProfilePage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const IntegrationPage = lazy(() => import('@/pages/IntegrationPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));
const ForbiddenPage = lazy(() => import('@/pages/ForbiddenPage'));
const AdministrationPage = lazy(() => import('@/pages/admin/AdministrationPage'));

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
  const { isAuthenticated, isLoading, mustChangePassword } = useAuth();
  const location = useLocation();

  // The session is confirmed with the backend, so it is not known on first
  // paint. Deciding before it resolves would bounce every deep link and every
  // refresh to /login, and from there to the dashboard — losing the
  // destination the user actually asked for.
  if (isLoading) return null;

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // Held at the door. Rendered in place of the route rather than redirected to
  // one, so there is no address to skip past and no destination to lose — the
  // requested URL is still there once the password is set.
  if (mustChangePassword) return <SetPasswordPage />;

  return <>{children}</>;
}

/**
 * Administration routes. The sidebar already hides these links from anyone
 * without the permission; this is what makes a typed or shared URL honour the
 * same rule. Rendered in place, like the password gate, so the address stays
 * put and explains itself.
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
  if (!allowed) return <ForbiddenPage />;
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
              may see, per project, and a gate in front of them would refuse
              people the instance would have answered. */}
          <Route path="/my-time" element={<MyTimePage />} />
          <Route path="/time-and-costs" element={<TimeCostsPage />} />

          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />}>
            <Route index element={<ProjectOverviewTab />} />
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
            path="/portfolios"
            element={
              <RequirePermission permission="portfolios:manage">
                <PortfoliosPage />
              </RequirePermission>
            }
          />
          {/* Not gated like the directory above it. A project's overview links
              here for anyone who can see that project, and the backend serves
              the read to any signed-in caller — gating it would 403 a member
              who simply clicked the portfolio their project is in. The page
              still checks `portfolios:manage` before offering edit or archive. */}
          <Route path="/portfolios/:portfolioId" element={<PortfolioDetailPage />} />

          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/teams/:teamId" element={<TeamDetailPage />} />

          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/agile" element={<AgilePage />} />
          <Route path="/boards" element={<BoardsPage />} />
          <Route path="/sprints" element={<SprintsPage />} />
          <Route path="/gantt" element={<GanttPage />} />

          <Route path="/reports" element={<ReportsPage />} />
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
