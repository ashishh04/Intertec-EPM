/**
 * Centralized NEXUS demo dataset.
 *
 * Everything in this folder is fictional and exists purely so the UI can be
 * exercised without a backend. Deleting `src/mocks/` and switching
 * `VITE_DATA_SOURCE=api` is all that is required to move to live data — no page
 * or component imports from here directly.
 *
 * Dates are generated relative to "today" so the demo never looks stale.
 */

import { addDays, addHours, startOfWeek, subDays, subHours } from 'date-fns';
import type {
  ActivityEntry,
  BurndownPoint,
  DeliveryTrendPoint,
  ID,
  IntegrationStatus,
  Milestone,
  NexusDocument,
  NexusNotification,
  NexusProject,
  NexusSprint,
  NexusTask,
  NexusTeam,
  NexusUser,
  TaskComment,
  TaskPriority,
  TaskStatus,
  TaskType,
  TeamMemberWorkload,
} from '@/types';
import { seededRandom, toISODateOnly } from '@/lib/utils';

const NOW = new Date();
const rand = seededRandom(20260830);

const iso = (date: Date) => date.toISOString();
const day = (offset: number) => toISODateOnly(addDays(NOW, offset));
const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

/* ========================================================================== */
/* People — all fictional                                                      */
/* ========================================================================== */

export const DEMO_USER_ID = 'usr-001';

export const users: NexusUser[] = [
  {
    id: DEMO_USER_ID,
    name: 'Alex Morgan',
    initials: 'AM',
    email: 'alex.morgan@demo.intertec.test',
    role: 'Project Manager',
    department: 'Delivery Management',
    status: 'online',
    timezone: 'Asia/Dubai (GMT+4)',
    accent: 'blue',
  },
  {
    id: 'usr-002',
    name: 'Rahul Kapoor',
    initials: 'RK',
    email: 'rahul.kapoor@demo.intertec.test',
    role: 'Senior Platform Engineer',
    department: 'Platform Engineering',
    status: 'online',
    timezone: 'Asia/Dubai (GMT+4)',
    accent: 'teal',
  },
  {
    id: 'usr-003',
    name: 'Priya Sharma',
    initials: 'PS',
    email: 'priya.sharma@demo.intertec.test',
    role: 'Engineering Lead',
    department: 'Platform Engineering',
    status: 'online',
    timezone: 'Asia/Kolkata (GMT+5:30)',
    accent: 'violet',
  },
  {
    id: 'usr-004',
    name: 'Arjun Menon',
    initials: 'AN',
    email: 'arjun.menon@demo.intertec.test',
    role: 'Cloud Architect',
    department: 'Cloud Services',
    status: 'away',
    timezone: 'Asia/Dubai (GMT+4)',
    accent: 'amber',
  },
  {
    id: 'usr-005',
    name: 'Vikram Kulkarni',
    initials: 'VK',
    email: 'vikram.kulkarni@demo.intertec.test',
    role: 'DevOps Engineer',
    department: 'Platform Engineering',
    status: 'online',
    timezone: 'Asia/Kolkata (GMT+5:30)',
    accent: 'rose',
  },
  {
    id: 'usr-006',
    name: 'Sara Haddad',
    initials: 'SH',
    email: 'sara.haddad@demo.intertec.test',
    role: 'Product Designer',
    department: 'Experience Design',
    status: 'online',
    timezone: 'Asia/Dubai (GMT+4)',
    accent: 'violet',
  },
  {
    id: 'usr-007',
    name: 'Daniel Okoro',
    initials: 'DO',
    email: 'daniel.okoro@demo.intertec.test',
    role: 'QA Lead',
    department: 'Quality Engineering',
    status: 'offline',
    timezone: 'Europe/London (GMT+1)',
    accent: 'slate',
  },
  {
    id: 'usr-008',
    name: 'Meera Iyer',
    initials: 'MI',
    email: 'meera.iyer@demo.intertec.test',
    role: 'Business Analyst',
    department: 'Delivery Management',
    status: 'online',
    timezone: 'Asia/Kolkata (GMT+5:30)',
    accent: 'teal',
  },
  {
    id: 'usr-009',
    name: 'Omar Al-Farsi',
    initials: 'OA',
    email: 'omar.alfarsi@demo.intertec.test',
    role: 'Security Engineer',
    department: 'Information Security',
    status: 'away',
    timezone: 'Asia/Muscat (GMT+4)',
    accent: 'amber',
  },
  {
    id: 'usr-010',
    name: 'Elena Petrova',
    initials: 'EP',
    email: 'elena.petrova@demo.intertec.test',
    role: 'Data Engineer',
    department: 'Data & AI',
    status: 'online',
    timezone: 'Europe/Berlin (GMT+2)',
    accent: 'blue',
  },
  {
    id: 'usr-011',
    name: 'Kabir Anand',
    initials: 'KA',
    email: 'kabir.anand@demo.intertec.test',
    role: 'Frontend Engineer',
    department: 'Platform Engineering',
    status: 'online',
    timezone: 'Asia/Dubai (GMT+4)',
    accent: 'rose',
  },
  {
    id: 'usr-012',
    name: 'Lina Fernandes',
    initials: 'LF',
    email: 'lina.fernandes@demo.intertec.test',
    role: 'Delivery Director',
    department: 'Delivery Management',
    status: 'online',
    timezone: 'Asia/Dubai (GMT+4)',
    accent: 'slate',
  },
  {
    id: 'usr-013',
    name: 'Tariq Nasser',
    initials: 'TN',
    email: 'tariq.nasser@demo.intertec.test',
    role: 'Site Reliability Engineer',
    department: 'Cloud Services',
    status: 'offline',
    timezone: 'Asia/Dubai (GMT+4)',
    accent: 'teal',
  },
  {
    id: 'usr-014',
    name: 'Nadia Rahman',
    initials: 'NR',
    email: 'nadia.rahman@demo.intertec.test',
    role: 'ML Engineer',
    department: 'Data & AI',
    status: 'online',
    timezone: 'Asia/Dubai (GMT+4)',
    accent: 'violet',
  },
];

const userIds = users.map((u) => u.id);

/* ========================================================================== */
/* Projects                                                                    */
/* ========================================================================== */

interface ProjectSeed {
  id: ID;
  identifier: string;
  name: string;
  description: string;
  status: NexusProject['status'];
  portfolio: string;
  ownerId: ID;
  memberIds: ID[];
  startOffset: number;
  dueOffset: number;
  progress: number;
  priority: TaskPriority;
  health: NexusProject['health'];
  budgetTotal: number;
  budgetUsed: number;
  openRiskCount: number;
}

const projectSeeds: ProjectSeed[] = [
  {
    id: 'prj-001',
    identifier: 'AOP',
    name: 'AutoOps Platform',
    description:
      'Self-service automation platform that lets delivery teams provision, monitor and remediate managed workloads without raising infrastructure tickets.',
    status: 'on_track',
    portfolio: 'Platform',
    ownerId: 'usr-003',
    memberIds: ['usr-002', 'usr-003', 'usr-005', 'usr-011', 'usr-007', 'usr-006'],
    startOffset: -96,
    dueOffset: 19,
    progress: 78,
    priority: 'high',
    health: { scope: 'healthy', schedule: 'healthy', resources: 'warning', budget: 'healthy', overall: 'healthy' },
    budgetTotal: 480000,
    budgetUsed: 342000,
    openRiskCount: 2,
  },
  {
    id: 'prj-002',
    identifier: 'CLM',
    name: 'Cloud Migration',
    description:
      'Phased migration of the remaining on-premise estate into the managed cloud landing zone, including data replication and cutover rehearsals.',
    status: 'at_risk',
    portfolio: 'Cloud',
    ownerId: 'usr-004',
    memberIds: ['usr-004', 'usr-013', 'usr-005', 'usr-009', 'usr-010'],
    startOffset: -140,
    dueOffset: 44,
    progress: 54,
    priority: 'critical',
    health: { scope: 'warning', schedule: 'critical', resources: 'warning', budget: 'warning', overall: 'critical' },
    budgetTotal: 720000,
    budgetUsed: 511000,
    openRiskCount: 5,
  },
  {
    id: 'prj-003',
    identifier: 'CPX',
    name: 'Customer Portal',
    description:
      'Unified customer experience for service requests, contract visibility and delivery reporting, replacing three legacy portals.',
    status: 'on_track',
    portfolio: 'Customer',
    ownerId: 'usr-008',
    memberIds: ['usr-008', 'usr-006', 'usr-011', 'usr-007', 'usr-001'],
    startOffset: -72,
    dueOffset: 61,
    progress: 46,
    priority: 'high',
    health: { scope: 'healthy', schedule: 'healthy', resources: 'healthy', budget: 'healthy', overall: 'healthy' },
    budgetTotal: 390000,
    budgetUsed: 168000,
    openRiskCount: 1,
  },
  {
    id: 'prj-004',
    identifier: 'IDO',
    name: 'Internal DevOps',
    description:
      'Golden CI/CD pipelines, shared build runners and release governance for every internal engineering team.',
    status: 'on_track',
    portfolio: 'Platform',
    ownerId: 'usr-005',
    memberIds: ['usr-005', 'usr-002', 'usr-013', 'usr-003'],
    startOffset: -210,
    dueOffset: 33,
    progress: 68,
    priority: 'medium',
    health: { scope: 'healthy', schedule: 'warning', resources: 'healthy', budget: 'healthy', overall: 'healthy' },
    budgetTotal: 260000,
    budgetUsed: 158000,
    openRiskCount: 1,
  },
  {
    id: 'prj-005',
    identifier: 'AKP',
    name: 'AI Knowledge Platform',
    description:
      'Retrieval platform over delivery documentation, runbooks and post-incident reviews, exposed to internal teams through a governed search API.',
    status: 'at_risk',
    portfolio: 'Innovation',
    ownerId: 'usr-014',
    memberIds: ['usr-014', 'usr-010', 'usr-006', 'usr-011'],
    startOffset: -54,
    dueOffset: 75,
    progress: 31,
    priority: 'high',
    health: { scope: 'warning', schedule: 'warning', resources: 'critical', budget: 'healthy', overall: 'warning' },
    budgetTotal: 310000,
    budgetUsed: 96000,
    openRiskCount: 3,
  },
  {
    id: 'prj-006',
    identifier: 'IFM',
    name: 'Infrastructure Modernization',
    description:
      'Refresh of core network, storage and virtualization estate across the regional data centres ahead of the support end-of-life dates.',
    status: 'delayed',
    portfolio: 'Cloud',
    ownerId: 'usr-013',
    memberIds: ['usr-013', 'usr-004', 'usr-009', 'usr-002'],
    startOffset: -168,
    dueOffset: -6,
    progress: 62,
    priority: 'critical',
    health: { scope: 'warning', schedule: 'critical', resources: 'critical', budget: 'warning', overall: 'critical' },
    budgetTotal: 640000,
    budgetUsed: 598000,
    openRiskCount: 4,
  },
  {
    id: 'prj-007',
    identifier: 'SCP',
    name: 'Security Compliance Program',
    description:
      'ISO 27001 surveillance readiness, access review automation and evidence collection across all managed service lines.',
    status: 'on_track',
    portfolio: 'Governance',
    ownerId: 'usr-009',
    memberIds: ['usr-009', 'usr-007', 'usr-012', 'usr-005'],
    startOffset: -88,
    dueOffset: 52,
    progress: 57,
    priority: 'high',
    health: { scope: 'healthy', schedule: 'healthy', resources: 'warning', budget: 'healthy', overall: 'healthy' },
    budgetTotal: 190000,
    budgetUsed: 104000,
    openRiskCount: 1,
  },
  {
    id: 'prj-008',
    identifier: 'DPR',
    name: 'Data Platform Refresh',
    description:
      'Consolidation of reporting marts onto the new lakehouse, with lineage tracking and a governed semantic layer for delivery analytics.',
    status: 'paused',
    portfolio: 'Innovation',
    ownerId: 'usr-010',
    memberIds: ['usr-010', 'usr-014', 'usr-008'],
    startOffset: -120,
    dueOffset: 98,
    progress: 24,
    priority: 'medium',
    health: { scope: 'warning', schedule: 'warning', resources: 'critical', budget: 'healthy', overall: 'warning' },
    budgetTotal: 280000,
    budgetUsed: 61000,
    openRiskCount: 2,
  },
  {
    id: 'prj-009',
    identifier: 'MSP',
    name: 'Managed Services Onboarding',
    description:
      'Standardized onboarding runbook, tooling and reporting pack for new managed service customers. Closed after the final handover review.',
    status: 'completed',
    portfolio: 'Customer',
    ownerId: 'usr-012',
    memberIds: ['usr-012', 'usr-008', 'usr-007'],
    startOffset: -260,
    dueOffset: -24,
    progress: 100,
    priority: 'medium',
    health: { scope: 'healthy', schedule: 'healthy', resources: 'healthy', budget: 'healthy', overall: 'healthy' },
    budgetTotal: 150000,
    budgetUsed: 143000,
    openRiskCount: 0,
  },
];

/* ========================================================================== */
/* Work packages                                                               */
/* ========================================================================== */

interface TaskSeed {
  subject: string;
  type: TaskType;
  labels: string[];
}

const taskSeedsByProject: Record<ID, TaskSeed[]> = {
  'prj-001': [
    { subject: 'Implement Redis caching layer', type: 'feature', labels: ['performance', 'backend'] },
    { subject: 'Configure production monitoring dashboards', type: 'task', labels: ['observability'] },
    { subject: 'Create authentication middleware', type: 'feature', labels: ['security', 'backend'] },
    { subject: 'Design remediation workflow builder', type: 'feature', labels: ['design', 'frontend'] },
    { subject: 'Automate runbook execution engine', type: 'epic', labels: ['automation'] },
    { subject: 'Fix intermittent webhook delivery failures', type: 'bug', labels: ['reliability'] },
    { subject: 'Add rate limiting to the public automation API', type: 'task', labels: ['api', 'security'] },
    { subject: 'Write integration tests for the scheduler', type: 'task', labels: ['testing'] },
    { subject: 'Publish v2 automation API documentation', type: 'task', labels: ['docs'] },
    { subject: 'Introduce audit trail for automation runs', type: 'feature', labels: ['compliance'] },
    { subject: 'Optimise task queue throughput', type: 'task', labels: ['performance'] },
    { subject: 'Resolve memory leak in worker pool', type: 'bug', labels: ['reliability', 'backend'] },
    { subject: 'Build approval gate for destructive actions', type: 'feature', labels: ['security'] },
    { subject: 'Roll out structured logging across services', type: 'task', labels: ['observability'] },
  ],
  'prj-002': [
    { subject: 'Complete landing zone network peering', type: 'task', labels: ['network'] },
    { subject: 'Migrate identity provider to managed tenant', type: 'feature', labels: ['identity'] },
    { subject: 'Rehearse database cutover for wave 3', type: 'task', labels: ['database', 'cutover'] },
    { subject: 'Resolve latency regression after wave 2 cutover', type: 'bug', labels: ['performance'] },
    { subject: 'Document rollback procedure for each wave', type: 'task', labels: ['docs', 'risk'] },
    { subject: 'Provision disaster recovery region', type: 'feature', labels: ['resilience'] },
    { subject: 'Validate data replication consistency', type: 'task', labels: ['database'] },
    { subject: 'Decommission legacy file cluster', type: 'task', labels: ['cleanup'] },
    { subject: 'Right-size compute reservations', type: 'task', labels: ['cost'] },
    { subject: 'Close firewall findings from migration review', type: 'bug', labels: ['security'] },
    { subject: 'Establish cost anomaly alerting', type: 'feature', labels: ['cost', 'observability'] },
    { subject: 'Wave 4 application dependency mapping', type: 'task', labels: ['planning'] },
  ],
  'prj-003': [
    { subject: 'Build service request submission flow', type: 'feature', labels: ['frontend'] },
    { subject: 'Design contract visibility dashboard', type: 'feature', labels: ['design'] },
    { subject: 'Complete API integration with ticketing backend', type: 'task', labels: ['api'] },
    { subject: 'Implement role-based portal permissions', type: 'feature', labels: ['security'] },
    { subject: 'Add accessibility audit fixes for WCAG AA', type: 'task', labels: ['accessibility'] },
    { subject: 'Fix session timeout on the reporting page', type: 'bug', labels: ['frontend'] },
    { subject: 'Create customer onboarding walkthrough', type: 'task', labels: ['content'] },
    { subject: 'Set up end-to-end test suite', type: 'task', labels: ['testing'] },
    { subject: 'Localise portal for Arabic', type: 'feature', labels: ['i18n'] },
    { subject: 'Prepare release documentation', type: 'task', labels: ['docs'] },
    { subject: 'Instrument portal usage analytics', type: 'task', labels: ['analytics'] },
  ],
  'prj-004': [
    { subject: 'Publish golden pipeline template', type: 'feature', labels: ['cicd'] },
    { subject: 'Migrate build runners to autoscaling pool', type: 'task', labels: ['infrastructure'] },
    { subject: 'Add SBOM generation to release pipeline', type: 'feature', labels: ['security', 'compliance'] },
    { subject: 'Reduce average pipeline duration below 8 minutes', type: 'task', labels: ['performance'] },
    { subject: 'Fix flaky deployment approval step', type: 'bug', labels: ['cicd'] },
    { subject: 'Introduce environment promotion policy', type: 'task', labels: ['governance'] },
    { subject: 'Onboard the Customer Portal team', type: 'task', labels: ['enablement'] },
    { subject: 'Automate secret rotation for shared runners', type: 'feature', labels: ['security'] },
    { subject: 'Deprecate legacy build scripts', type: 'task', labels: ['cleanup'] },
  ],
  'prj-005': [
    { subject: 'Design retrieval evaluation harness', type: 'feature', labels: ['ml'] },
    { subject: 'Build document ingestion pipeline', type: 'epic', labels: ['data'] },
    { subject: 'Define access governance model for indexed content', type: 'task', labels: ['governance'] },
    { subject: 'Benchmark embedding models on delivery corpus', type: 'task', labels: ['ml', 'research'] },
    { subject: 'Implement source citation in search results', type: 'feature', labels: ['frontend'] },
    { subject: 'Chunking strategy for runbook documents', type: 'task', labels: ['ml'] },
    { subject: 'Fix duplicate results for revised documents', type: 'bug', labels: ['search'] },
    { subject: 'Draft responsible AI usage guidelines', type: 'task', labels: ['governance', 'docs'] },
    { subject: 'Stand up staging vector store', type: 'task', labels: ['infrastructure'] },
  ],
  'prj-006': [
    { subject: 'Replace end-of-life core switches', type: 'task', labels: ['network'] },
    { subject: 'Upgrade storage array firmware', type: 'task', labels: ['storage'] },
    { subject: 'Resolve failed hypervisor host in DC2', type: 'bug', labels: ['virtualization', 'incident'] },
    { subject: 'Complete capacity plan for FY27', type: 'task', labels: ['planning'] },
    { subject: 'Retire unsupported backup appliances', type: 'task', labels: ['backup'] },
    { subject: 'Validate power redundancy in DC1', type: 'task', labels: ['facilities'] },
    { subject: 'Refresh out-of-band management network', type: 'feature', labels: ['network'] },
    { subject: 'Close audit findings on patch currency', type: 'bug', labels: ['compliance'] },
  ],
  'prj-007': [
    { subject: 'Automate quarterly access reviews', type: 'feature', labels: ['identity', 'compliance'] },
    { subject: 'Collect evidence pack for surveillance audit', type: 'task', labels: ['compliance'] },
    { subject: 'Remediate findings from penetration test', type: 'bug', labels: ['security'] },
    { subject: 'Update information security policy set', type: 'task', labels: ['policy'] },
    { subject: 'Roll out phishing simulation programme', type: 'task', labels: ['awareness'] },
    { subject: 'Map controls to the new service lines', type: 'task', labels: ['compliance'] },
    { subject: 'Implement vulnerability SLA reporting', type: 'feature', labels: ['reporting'] },
  ],
  'prj-008': [
    { subject: 'Migrate delivery mart to the lakehouse', type: 'epic', labels: ['data'] },
    { subject: 'Define semantic layer for delivery metrics', type: 'feature', labels: ['data', 'analytics'] },
    { subject: 'Backfill historical time entries', type: 'task', labels: ['data'] },
    { subject: 'Implement column-level lineage capture', type: 'feature', labels: ['governance'] },
    { subject: 'Retire duplicate reporting extracts', type: 'task', labels: ['cleanup'] },
    { subject: 'Fix nightly load failure on the utilisation job', type: 'bug', labels: ['data'] },
  ],
  'prj-009': [
    { subject: 'Publish onboarding runbook v3', type: 'task', labels: ['docs'] },
    { subject: 'Standardise reporting pack template', type: 'task', labels: ['reporting'] },
    { subject: 'Complete final handover review', type: 'milestone', labels: ['closure'] },
    { subject: 'Archive project workspace', type: 'task', labels: ['closure'] },
  ],
};

const DESCRIPTIONS = [
  'Scope agreed with the delivery lead during sprint planning. Acceptance criteria are captured in the linked specification and reviewed with QA before work starts.',
  'Follow the standard implementation checklist: design note, peer review, automated coverage, and an operational readiness check before promotion.',
  'Dependencies are tracked against the parent epic. Any change to the interface contract needs sign-off from the platform team.',
  'Raised from the last delivery review. Progress is reported weekly against the agreed remediation plan.',
  'This item carries a customer-facing commitment, so the target date should not move without an approved change request.',
];

function statusForProject(projectProgress: number): TaskStatus {
  const roll = rand() * 100;
  if (roll < projectProgress * 0.72) return 'done';
  if (roll < projectProgress * 0.72 + 14) return 'in_progress';
  if (roll < projectProgress * 0.72 + 22) return 'review';
  if (roll < projectProgress * 0.72 + 26) return 'blocked';
  if (roll < projectProgress * 0.72 + 46) return 'todo';
  return 'backlog';
}

function buildTasks(): NexusTask[] {
  const result: NexusTask[] = [];
  let counter = 100;

  for (const seed of projectSeeds) {
    const seeds = taskSeedsByProject[seed.id] ?? [];
    seeds.forEach((taskSeed, index) => {
      counter += 1;
      const status: TaskStatus =
        seed.status === 'completed' ? 'done' : statusForProject(seed.progress);
      const isDone = status === 'done';

      // Keep the demo user meaningfully loaded so My Work is never empty.
      const assigneeId =
        index % 4 === 0 && seed.id !== 'prj-009'
          ? DEMO_USER_ID
          : pick(seed.memberIds.length ? seed.memberIds : userIds);

      const dueOffset = isDone
        ? between(-45, -2)
        : status === 'blocked' || (index % 5 === 0 && seed.status !== 'on_track')
          ? between(-12, -1)
          : between(-3, 34);

      const estimated = pick([2, 3, 5, 8, 8, 13, 16, 21]);
      const created = subDays(NOW, between(12, 110));

      result.push({
        id: `tsk-${counter}`,
        key: `OP-${counter}`,
        subject: taskSeed.subject,
        description: pick(DESCRIPTIONS),
        type: taskSeed.type,
        status,
        priority: pick<TaskPriority>(
          taskSeed.type === 'bug'
            ? ['critical', 'high', 'high', 'medium']
            : ['critical', 'high', 'medium', 'medium', 'low'],
        ),
        projectId: seed.id,
        assigneeId,
        authorId: seed.ownerId,
        // Sprint membership is assigned in a dedicated pass below.
        sprintId: undefined,
        version: pick(['2026.3', '2026.4', 'Backlog']),
        startDate: day(between(-30, 2)),
        dueDate: day(dueOffset),
        estimatedHours: estimated,
        spentHours: isDone ? estimated + between(-2, 4) : Math.max(0, Math.round(estimated * rand())),
        storyPoints: pick([1, 2, 3, 5, 5, 8, 13]),
        labels: taskSeed.labels,
        progress: isDone ? 100 : status === 'in_progress' ? between(25, 85) : status === 'review' ? 90 : 0,
        watcherIds: [seed.ownerId],
        createdAt: iso(created),
        updatedAt: iso(subHours(NOW, between(1, 200))),
      });
    });
  }

  return result;
}

export const projects: NexusProject[] = projectSeeds.map((seed) => ({
  id: seed.id,
  identifier: seed.identifier,
  name: seed.name,
  description: seed.description,
  status: seed.status,
  progress: seed.progress,
  ownerId: seed.ownerId,
  memberIds: seed.memberIds,
  startDate: day(seed.startOffset),
  dueDate: day(seed.dueOffset),
  priority: seed.priority,
  health: seed.health,
  taskCount: 0,
  completedTaskCount: 0,
  openRiskCount: seed.openRiskCount,
  portfolio: seed.portfolio,
  budgetTotal: seed.budgetTotal,
  budgetUsed: seed.budgetUsed,
  createdAt: iso(addDays(NOW, seed.startOffset)),
  updatedAt: iso(subHours(NOW, between(2, 60))),
}));

export const tasks: NexusTask[] = buildTasks();

// Derive the project task counters from the generated work packages so the
// numbers shown on cards always agree with the underlying list.
for (const project of projects) {
  const projectTasks = tasks.filter((task) => task.projectId === project.id);
  project.taskCount = projectTasks.length;
  project.completedTaskCount = projectTasks.filter((task) => task.status === 'done').length;
}

/* ========================================================================== */
/* Milestones                                                                  */
/* ========================================================================== */

const MILESTONE_TEMPLATE: { name: string; offsetRatio: number }[] = [
  { name: 'Discovery', offsetRatio: 0 },
  { name: 'Design', offsetRatio: 0.25 },
  { name: 'Development', offsetRatio: 0.5 },
  { name: 'QA', offsetRatio: 0.78 },
  { name: 'Release', offsetRatio: 1 },
];

export const milestones: Milestone[] = projectSeeds.flatMap((seed) =>
  MILESTONE_TEMPLATE.map((template, index) => {
    const span = seed.dueOffset - seed.startOffset;
    const offset = Math.round(seed.startOffset + span * template.offsetRatio);
    const reached = seed.progress >= template.offsetRatio * 100 + 1;
    return {
      id: `mls-${seed.identifier}-${index}`,
      projectId: seed.id,
      name: template.name,
      date: day(offset),
      status: offset < 0 && reached ? 'completed' : offset <= 0 ? 'in_progress' : 'upcoming',
    } satisfies Milestone;
  }),
);

/* ========================================================================== */
/* Sprints                                                                     */
/* ========================================================================== */

function buildBurndown(
  startOffset: number,
  lengthDays: number,
  committed: number,
  completed: number,
): BurndownPoint[] {
  const points: BurndownPoint[] = [];
  const perDay = committed / (lengthDays - 1);
  let remaining = committed;

  for (let index = 0; index < lengthDays; index += 1) {
    const date = addDays(NOW, startOffset + index);
    const elapsed = startOffset + index <= 0;
    if (index > 0 && elapsed) {
      const burn = (completed / Math.max(1, Math.abs(startOffset))) * (0.55 + rand() * 0.95);
      remaining = Math.max(committed - completed, remaining - burn);
    }
    points.push({
      date: toISODateOnly(date),
      label: toISODateOnly(date).slice(5),
      ideal: Math.round(Math.max(0, committed - perDay * index)),
      remaining: elapsed ? Math.round(remaining) : null,
    });
  }
  return points;
}

/**
 * Fills a sprint up to a target capacity, taking work packages round-robin
 * across the contributing projects so no single project dominates the sprint.
 */
function fillSprint(
  sprintId: ID,
  capacityPoints: number,
  isCandidate: (task: NexusTask) => boolean,
): void {
  const byProject = new Map<ID, NexusTask[]>();
  for (const task of tasks) {
    if (task.sprintId || !isCandidate(task)) continue;
    const bucket = byProject.get(task.projectId);
    if (bucket) bucket.push(task);
    else byProject.set(task.projectId, [task]);
  }

  const queues = [...byProject.values()];
  let committed = 0;
  let cursor = 0;

  while (queues.some((queue) => queue.length > 0) && committed < capacityPoints) {
    const queue = queues[cursor % queues.length];
    cursor += 1;
    const task = queue.shift();
    if (!task) continue;
    task.sprintId = sprintId;
    committed += task.storyPoints ?? 0;
  }
}

const SPRINT_24_PROJECTS: ID[] = ['prj-001', 'prj-002', 'prj-003', 'prj-004', 'prj-005'];

// The active sprint: committed work from the delivery projects, finished and
// unfinished alike. Then the previous sprint's closed work, then next sprint's
// plan drawn from the backlog.
fillSprint('spr-024', 104, (task) => task.status !== 'backlog' && SPRINT_24_PROJECTS.includes(task.projectId));
fillSprint('spr-023', 96, (task) => task.status === 'done');
fillSprint('spr-025', 88, (task) => task.status === 'backlog');

/**
 * Sprint totals are derived from the work packages actually assigned to each
 * sprint, so the board, the burndown and the headline numbers always agree.
 */
function sprintPoints(sprintId: ID): { committed: number; completed: number } {
  const items = tasks.filter((task) => task.sprintId === sprintId);
  const committed = items.reduce((sum, task) => sum + (task.storyPoints ?? 0), 0);
  const completed = items
    .filter((task) => task.status === 'done')
    .reduce((sum, task) => sum + (task.storyPoints ?? 0), 0);
  return { committed, completed };
}

const sprintStart = startOfWeek(subDays(NOW, 6), { weekStartsOn: 1 });
const sprintStartOffset = Math.round(
  (sprintStart.getTime() - new Date(toISODateOnly(NOW)).getTime()) / 86_400_000,
);

const points23 = sprintPoints('spr-023');
const points24 = sprintPoints('spr-024');
const points25 = sprintPoints('spr-025');

export const sprints: NexusSprint[] = [
  {
    id: 'spr-023',
    name: 'Sprint 23',
    goal: 'Stabilise the automation scheduler and close the wave 2 migration backlog.',
    projectIds: ['prj-001', 'prj-002', 'prj-004'],
    state: 'completed',
    startDate: day(sprintStartOffset - 14),
    endDate: day(sprintStartOffset - 1),
    committedPoints: points23.committed,
    completedPoints: points23.completed,
    burndown: buildBurndown(sprintStartOffset - 14, 14, points23.committed, points23.completed),
  },
  {
    id: 'spr-024',
    name: 'Sprint 24',
    goal: 'Ship the caching layer, complete portal permissions, and clear the migration cutover blockers.',
    projectIds: ['prj-001', 'prj-002', 'prj-003', 'prj-004', 'prj-005'],
    state: 'active',
    startDate: day(sprintStartOffset),
    endDate: day(sprintStartOffset + 13),
    committedPoints: points24.committed,
    completedPoints: points24.completed,
    burndown: buildBurndown(sprintStartOffset, 14, points24.committed, points24.completed),
  },
  {
    id: 'spr-025',
    name: 'Sprint 25',
    goal: 'Begin the knowledge platform ingestion pipeline and finish the compliance evidence pack.',
    projectIds: ['prj-005', 'prj-007', 'prj-003'],
    state: 'planned',
    startDate: day(sprintStartOffset + 14),
    endDate: day(sprintStartOffset + 27),
    committedPoints: points25.committed,
    completedPoints: 0,
    burndown: buildBurndown(sprintStartOffset + 14, 14, points25.committed, 0),
  },
];

/* ========================================================================== */
/* Teams                                                                       */
/* ========================================================================== */

export const teams: NexusTeam[] = [
  {
    id: 'tm-001',
    name: 'Platform Engineering',
    slug: 'platform-engineering',
    description: 'Owns the shared automation platform, internal developer tooling and delivery pipelines.',
    leadId: 'usr-003',
    memberIds: ['usr-003', 'usr-002', 'usr-005', 'usr-011', 'usr-013'],
    projectIds: ['prj-001', 'prj-004', 'prj-006'],
    capacity: 88,
    sprintProgress: 81,
  },
  {
    id: 'tm-002',
    name: 'Cloud Services',
    slug: 'cloud-services',
    description: 'Landing zone design, migration waves and run-state operations for managed cloud workloads.',
    leadId: 'usr-004',
    memberIds: ['usr-004', 'usr-013', 'usr-009'],
    projectIds: ['prj-002', 'prj-006'],
    capacity: 94,
    sprintProgress: 63,
  },
  {
    id: 'tm-003',
    name: 'Experience Design',
    slug: 'experience-design',
    description: 'Product design, research and the shared Nexus design system.',
    leadId: 'usr-006',
    memberIds: ['usr-006', 'usr-011'],
    projectIds: ['prj-003', 'prj-005'],
    capacity: 71,
    sprintProgress: 74,
  },
  {
    id: 'tm-004',
    name: 'Quality Engineering',
    slug: 'quality-engineering',
    description: 'Test strategy, automation coverage and release readiness sign-off.',
    leadId: 'usr-007',
    memberIds: ['usr-007', 'usr-008'],
    projectIds: ['prj-001', 'prj-003', 'prj-007'],
    capacity: 66,
    sprintProgress: 69,
  },
  {
    id: 'tm-005',
    name: 'Data & AI',
    slug: 'data-and-ai',
    description: 'Lakehouse platform, delivery analytics and the knowledge retrieval service.',
    leadId: 'usr-010',
    memberIds: ['usr-010', 'usr-014'],
    projectIds: ['prj-005', 'prj-008'],
    capacity: 97,
    sprintProgress: 42,
  },
  {
    id: 'tm-006',
    name: 'Delivery Management',
    slug: 'delivery-management',
    description: 'Programme governance, portfolio reporting and customer delivery assurance.',
    leadId: 'usr-012',
    memberIds: ['usr-012', 'usr-001', 'usr-008'],
    projectIds: ['prj-003', 'prj-007', 'prj-009'],
    capacity: 79,
    sprintProgress: 86,
  },
];

export const workloads: TeamMemberWorkload[] = users.map((user) => {
  const assigned = tasks.filter((task) => task.assigneeId === user.id && task.status !== 'done');
  const capacityHours = 40;
  const hoursLogged = Math.min(capacityHours, 18 + Math.round(rand() * 22));
  return {
    userId: user.id,
    allocation: Math.min(100, 45 + assigned.length * 6 + Math.round(rand() * 12)),
    assignedTasks: assigned.length,
    completedThisSprint: tasks.filter(
      (task) => task.assigneeId === user.id && task.status === 'done' && task.sprintId === 'spr-024',
    ).length,
    hoursLogged,
    hoursCapacity: capacityHours,
  };
});

/* ========================================================================== */
/* Comments, activity, notifications                                           */
/* ========================================================================== */

const COMMENT_BODIES = [
  'Picked this up this morning. The interface contract is agreed, so implementation should land before the review gate.',
  'Blocked on the staging credentials rotation — raised with the platform team and tracking it on the risk log.',
  'Updated the acceptance criteria after the walkthrough. Please re-check the edge case around concurrent updates.',
  'Test coverage is in place and the pipeline is green. Moving this to review.',
  'Confirmed with the customer that the target date is unchanged. No change request required.',
];

export const comments: TaskComment[] = tasks.slice(0, 40).flatMap((task, index) => {
  const count = index % 3 === 0 ? 3 : index % 2 === 0 ? 2 : 1;
  return Array.from({ length: count }, (_, commentIndex) => ({
    id: `cmt-${task.id}-${commentIndex}`,
    taskId: task.id,
    authorId: pick(userIds),
    body: COMMENT_BODIES[(index + commentIndex) % COMMENT_BODIES.length],
    createdAt: iso(subHours(NOW, (count - commentIndex) * between(3, 40))),
  }));
});

export const activity: ActivityEntry[] = (() => {
  const entries: ActivityEntry[] = [];
  const recentTasks = [...tasks]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 30);

  recentTasks.forEach((task, index) => {
    entries.push({
      id: `act-${index}`,
      actorId: task.assigneeId ?? task.authorId,
      action:
        task.status === 'done'
          ? 'completed'
          : task.status === 'in_progress'
            ? 'status_changed'
            : index % 3 === 0
              ? 'commented'
              : 'updated',
      objectLabel: task.key,
      objectType: 'task',
      objectId: task.id,
      projectId: task.projectId,
      detail: task.subject,
      timestamp: iso(subHours(NOW, index * between(1, 4) + 1)),
    });
  });

  milestones
    .filter((milestone) => milestone.status === 'completed')
    .slice(0, 6)
    .forEach((milestone, index) => {
      entries.push({
        id: `act-mls-${index}`,
        actorId: pick(userIds),
        action: 'completed',
        objectLabel: milestone.name,
        objectType: 'milestone',
        objectId: milestone.id,
        projectId: milestone.projectId,
        detail: 'Milestone reached',
        timestamp: iso(subHours(NOW, 6 + index * 9)),
      });
    });

  projects.slice(0, 4).forEach((project, index) => {
    entries.push({
      id: `act-prj-${index}`,
      actorId: project.ownerId,
      action: 'status_changed',
      objectLabel: project.name,
      objectType: 'project',
      objectId: project.id,
      projectId: project.id,
      detail: `Status set to ${project.status.replace('_', ' ')}`,
      timestamp: iso(subHours(NOW, 3 + index * 14)),
    });
  });

  return entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
})();

export const notifications: NexusNotification[] = (() => {
  const myTasks = tasks.filter((task) => task.assigneeId === DEMO_USER_ID).slice(0, 12);
  const result: NexusNotification[] = [];

  myTasks.slice(0, 5).forEach((task, index) => {
    result.push({
      id: `ntf-asg-${index}`,
      category: 'assignment',
      title: `${users.find((u) => u.id === task.authorId)?.name ?? 'A teammate'} assigned you a task`,
      body: task.subject,
      actorId: task.authorId,
      taskKey: task.key,
      taskId: task.id,
      projectId: task.projectId,
      read: index > 1,
      timestamp: iso(subHours(NOW, index === 0 ? 0.17 : index * 5)),
    });
  });

  myTasks.slice(5, 8).forEach((task, index) => {
    result.push({
      id: `ntf-mnt-${index}`,
      category: 'mention',
      title: `${users.find((u) => u.id === task.watcherIds[0])?.name ?? 'A teammate'} mentioned you`,
      body: `"Can you confirm the target date on ${task.key} before the review?"`,
      actorId: task.watcherIds[0],
      taskKey: task.key,
      taskId: task.id,
      projectId: task.projectId,
      read: index > 0,
      timestamp: iso(subHours(NOW, 2 + index * 7)),
    });
  });

  tasks
    .filter((task) => task.assigneeId === DEMO_USER_ID && task.status !== 'done')
    .slice(0, 3)
    .forEach((task, index) => {
      result.push({
        id: `ntf-dln-${index}`,
        category: 'deadline',
        title: 'Deadline approaching',
        body: `${task.key} · ${task.subject}`,
        taskKey: task.key,
        taskId: task.id,
        projectId: task.projectId,
        read: false,
        timestamp: iso(subHours(NOW, 4 + index * 11)),
      });
    });

  projects.slice(0, 3).forEach((project, index) => {
    result.push({
      id: `ntf-prj-${index}`,
      category: 'project_update',
      title: `${project.name} status updated`,
      body: `Health review completed by ${users.find((u) => u.id === project.ownerId)?.name}.`,
      actorId: project.ownerId,
      projectId: project.id,
      read: index > 0,
      timestamp: iso(subHours(NOW, 9 + index * 13)),
    });
  });

  result.push({
    id: 'ntf-sys-0',
    category: 'system',
    title: 'OpenProject sync completed',
    body: 'All work packages, members and versions are up to date.',
    read: true,
    timestamp: iso(subHours(NOW, 1)),
  });

  return result.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
})();

/* ========================================================================== */
/* Documents                                                                   */
/* ========================================================================== */

const DOCUMENT_SEEDS: { name: string; kind: NexusDocument['kind']; projectId?: ID }[] = [
  { name: 'AutoOps Platform — Solution Design.pdf', kind: 'pdf', projectId: 'prj-001' },
  { name: 'Automation API Specification.md', kind: 'markdown', projectId: 'prj-001' },
  { name: 'Sprint 24 Review Deck.pptx', kind: 'slide', projectId: 'prj-001' },
  { name: 'Cloud Migration Wave Plan.xlsx', kind: 'sheet', projectId: 'prj-002' },
  { name: 'Cutover Runbook v4.docx', kind: 'doc', projectId: 'prj-002' },
  { name: 'Landing Zone Network Diagram.png', kind: 'image', projectId: 'prj-002' },
  { name: 'Customer Portal — UX Research Summary.pdf', kind: 'pdf', projectId: 'prj-003' },
  { name: 'Portal Permission Matrix.xlsx', kind: 'sheet', projectId: 'prj-003' },
  { name: 'Golden Pipeline Standard.md', kind: 'markdown', projectId: 'prj-004' },
  { name: 'Knowledge Platform Evaluation Notes.docx', kind: 'doc', projectId: 'prj-005' },
  { name: 'Responsible AI Guidelines (draft).pdf', kind: 'pdf', projectId: 'prj-005' },
  { name: 'DC Refresh Capacity Model.xlsx', kind: 'sheet', projectId: 'prj-006' },
  { name: 'ISO 27001 Evidence Pack.zip', kind: 'archive', projectId: 'prj-007' },
  { name: 'Access Review Procedure.docx', kind: 'doc', projectId: 'prj-007' },
  { name: 'Lakehouse Semantic Layer Draft.md', kind: 'markdown', projectId: 'prj-008' },
  { name: 'Delivery Governance Handbook.pdf', kind: 'pdf' },
  { name: 'Weekly Portfolio Report.xlsx', kind: 'sheet' },
  { name: 'Onboarding Runbook v3.docx', kind: 'doc', projectId: 'prj-009' },
];

export const documents: NexusDocument[] = DOCUMENT_SEEDS.map((seed, index) => ({
  id: `doc-${index + 1}`,
  name: seed.name,
  kind: seed.kind,
  projectId: seed.projectId,
  ownerId: pick(userIds),
  sizeBytes: between(48_000, 14_000_000),
  updatedAt: iso(subHours(NOW, between(2, 700))),
  shared: index % 3 === 0,
}));

/* ========================================================================== */
/* Delivery trends and integration status                                      */
/* ========================================================================== */

// Historic sprints are fixed demo history; the two most recent points come from
// the derived totals so the charts agree with the sprint pages.
export const deliveryTrends: DeliveryTrendPoint[] = [
  { period: 'Sprint 18', completed: 62, created: 71, velocity: 62 },
  { period: 'Sprint 19', completed: 68, created: 66, velocity: 68 },
  { period: 'Sprint 20', completed: 74, created: 79, velocity: 74 },
  { period: 'Sprint 21', completed: 71, created: 68, velocity: 71 },
  { period: 'Sprint 22', completed: 83, created: 77, velocity: 83 },
  {
    period: 'Sprint 23',
    completed: points23.completed,
    created: points23.committed,
    velocity: points23.completed,
  },
  {
    period: 'Sprint 24',
    completed: points24.completed,
    created: points24.committed,
    velocity: points24.completed,
  },
];

export const integrationStatus: IntegrationStatus = {
  provider: 'openproject',
  state: 'connected',
  instanceUrl: 'https://openproject.internal.demo',
  apiState: 'connected',
  webhookState: 'connected',
  lastSyncAt: iso(subHours(NOW, 0.03)),
  apiVersion: 'v3',
  syncedResources: [
    { resource: 'Projects', count: projects.length, lastSyncAt: iso(subHours(NOW, 0.03)) },
    { resource: 'Work packages', count: tasks.length, lastSyncAt: iso(subHours(NOW, 0.03)) },
    { resource: 'Users', count: users.length, lastSyncAt: iso(subHours(NOW, 0.5)) },
    { resource: 'Memberships', count: projects.reduce((sum, p) => sum + p.memberIds.length, 0), lastSyncAt: iso(subHours(NOW, 0.5)) },
    { resource: 'Versions', count: 14, lastSyncAt: iso(subHours(NOW, 2)) },
    { resource: 'Time entries', count: 1_284, lastSyncAt: iso(subHours(NOW, 1)) },
  ],
};

/* ========================================================================== */
/* Calendar-friendly derived data                                              */
/* ========================================================================== */

export const meetings = [
  { title: 'Sprint Planning', offset: 0, hour: 10 },
  { title: 'Delivery Standup', offset: 1, hour: 9 },
  { title: 'Portfolio Review', offset: 3, hour: 14 },
  { title: 'Architecture Guild', offset: 5, hour: 11 },
  { title: 'Customer Steering Committee', offset: 8, hour: 15 },
  { title: 'Sprint Review', offset: 12, hour: 13 },
  { title: 'Sprint Retrospective', offset: 12, hour: 15 },
].map((meeting, index) => ({
  id: `evt-mtg-${index}`,
  title: meeting.title,
  date: iso(addHours(addDays(new Date(toISODateOnly(NOW)), meeting.offset), meeting.hour)),
}));
