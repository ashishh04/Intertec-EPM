import { lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useAuth } from '@/providers/AuthProvider';

/**
 * Routes are code-split so the initial bundle only carries the shell and the
 * dashboard path. Heavier surfaces (Gantt, analytics, board) load on demand.
 */
const LoginPage = lazy(() => import('@/pages/LoginPage'));
const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const MyWorkPage = lazy(() => import('@/pages/MyWorkPage'));
const ProjectsPage = lazy(() => import('@/pages/ProjectsPage'));
const ProjectDetailPage = lazy(() => import('@/pages/project/ProjectDetailPage'));
const ProjectOverviewTab = lazy(() => import('@/pages/project/ProjectOverviewTab'));
const ProjectTasksTab = lazy(() => import('@/pages/project/ProjectTasksTab'));
const ProjectBoardTab = lazy(() => import('@/pages/project/ProjectBoardTab'));
const ProjectSprintTab = lazy(() => import('@/pages/project/ProjectSprintTab'));
const ProjectGanttTab = lazy(() => import('@/pages/project/ProjectGanttTab'));
const ProjectTeamTab = lazy(() => import('@/pages/project/ProjectTeamTab'));
const ProjectDocumentsTab = lazy(() => import('@/pages/project/ProjectDocumentsTab'));
const ProjectActivityTab = lazy(() => import('@/pages/project/ProjectActivityTab'));
const ProjectReportsTab = lazy(() => import('@/pages/project/ProjectReportsTab'));
const TasksPage = lazy(() => import('@/pages/TasksPage'));
const TaskDetailPage = lazy(() => import('@/pages/TaskDetailPage'));
const TeamsPage = lazy(() => import('@/pages/TeamsPage'));
const TeamDetailPage = lazy(() => import('@/pages/TeamDetailPage'));
const CalendarPage = lazy(() => import('@/pages/CalendarPage'));
const AgilePage = lazy(() => import('@/pages/AgilePage'));
const BoardsPage = lazy(() => import('@/pages/BoardsPage'));
const SprintsPage = lazy(() => import('@/pages/SprintsPage'));
const GanttPage = lazy(() => import('@/pages/GanttPage'));
const ReportsPage = lazy(() => import('@/pages/ReportsPage'));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'));
const DocumentsPage = lazy(() => import('@/pages/DocumentsPage'));
const NotificationsPage = lazy(() => import('@/pages/NotificationsPage'));
const ProfilePage = lazy(() => import('@/pages/ProfilePage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const IntegrationPage = lazy(() => import('@/pages/IntegrationPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  // The session is confirmed with the backend, so it is not known on first
  // paint. Deciding before it resolves would bounce every deep link and every
  // refresh to /login, and from there to the dashboard — losing the
  // destination the user actually asked for.
  if (isLoading) return null;

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

export function App() {
  const { isAuthenticated, isLoading } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        // Same reason as RequireAuth: show nothing until the session is known,
        // rather than flashing the sign-in form at someone already signed in.
        element={
          isLoading ? null : isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginPage />
        }
      />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/my-work" element={<MyWorkPage />} />

        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectDetailPage />}>
          <Route index element={<ProjectOverviewTab />} />
          <Route path="tasks" element={<ProjectTasksTab />} />
          <Route path="board" element={<ProjectBoardTab />} />
          <Route path="sprint" element={<ProjectSprintTab />} />
          <Route path="gantt" element={<ProjectGanttTab />} />
          <Route path="team" element={<ProjectTeamTab />} />
          <Route path="documents" element={<ProjectDocumentsTab />} />
          <Route path="activity" element={<ProjectActivityTab />} />
          <Route path="reports" element={<ProjectReportsTab />} />
        </Route>

        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:taskId" element={<TaskDetailPage />} />

        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/teams/:teamId" element={<TeamDetailPage />} />

        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/agile" element={<AgilePage />} />
        <Route path="/boards" element={<BoardsPage />} />
        <Route path="/sprints" element={<SprintsPage />} />
        <Route path="/gantt" element={<GanttPage />} />

        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/integration" element={<IntegrationPage />} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
