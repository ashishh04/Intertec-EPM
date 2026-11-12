import { Suspense, lazy, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Briefcase,
  DoorOpen,
  FilePlus2,
  CalendarClock,
  Clock3,
  FolderPlus,
  ListPlus,
  Megaphone,
  Plus,
  ReceiptText,
  ShieldAlert,
  SlidersHorizontal,
  SlidersVertical,
  Timer,
  type LucideIcon,
} from 'lucide-react';

import { ProjectDialog } from '@/components/common/ProjectDialog';
import { SprintDialog } from '@/components/sprints/SprintDialog';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ROLE_ACCESS } from '@/config/navigation';
import { useRiskSetup } from '@/hooks/useRisks';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { useAuth } from '@/providers/AuthProvider';
import { useUI } from '@/providers/UIProvider';

/*
 * The heavier dialogs, loaded on demand: the header paints on every page, and
 * importing these statically would put their pickers and hooks in the shell's
 * critical chunk for dialogs most page loads never open. Each is mounted only
 * while open, since a mounted lazy component has already been fetched.
 */
const MeetingDialog = lazy(() =>
  import('@/components/meetings/MeetingDialog').then((module) => ({ default: module.MeetingDialog })),
);
const NewsDialog = lazy(() => import('@/components/news/NewsDialog').then((module) => ({ default: module.NewsDialog })));
const ClaimDialog = lazy(() =>
  import('@/components/expenses/ClaimDialog').then((module) => ({ default: module.ClaimDialog })),
);
const RiskDialog = lazy(() => import('@/components/risks/RiskDialog').then((module) => ({ default: module.RiskDialog })));
const TeamDialog = lazy(() => import('@/components/teams/TeamDialog').then((module) => ({ default: module.TeamDialog })));
const StatusReportDialog = lazy(() =>
  import('@/components/status/StatusReportDialog').then((module) => ({ default: module.StatusReportDialog })),
);
const ProjectRequestDialog = lazy(() =>
  import('@/components/requests/ProjectRequestDialog').then((module) => ({ default: module.ProjectRequestDialog })),
);
const GateReviewDialog = lazy(() =>
  import('@/components/projects/StageGatesCard').then((module) => ({ default: module.GateReviewDialog })),
);

type DialogKey =
  | 'project'
  | 'sprint'
  | 'meeting'
  | 'news'
  | 'expense'
  | 'risk'
  | 'client'
  | 'project-status'
  | 'portfolio-status'
  | 'project-request'
  | 'stage-gate';

interface Tile {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  /** Hidden from people who could not go on to create it. */
  shown: boolean;
}

interface Section {
  key: string;
  title?: string;
  tiles: Tile[];
}

/**
 * The Create menu: everything a person can start from anywhere, as a grid of
 * tiles in three groups (work, apps and people), each offered only to people
 * who may go on to create it.
 */
export function CreateMenu() {
  const navigate = useNavigate();
  const { openTaskDrawer } = useUI();
  const { can, canAnywhere, role } = useAuth();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKey>();
  const delivery = (ROLE_ACCESS.delivery as readonly string[]).includes(role);

  // Asked only once the menu has been opened, so a page load costs nothing.
  const riskSetup = useRiskSetup(open || dialog === 'risk');

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  const sections: Section[] = [
    {
      key: 'work',
      tiles: [
        {
          key: 'project',
          label: t('Project'),
          icon: FolderPlus,
          onSelect: choose(() => setDialog('project')),
          shown: can('project:create'),
        },
        {
          key: 'task',
          label: t('Task'),
          icon: ListPlus,
          onSelect: choose(() => openTaskDrawer()),
          shown: canAnywhere('task:create'),
        },
        { key: 'timesheet', label: t('Timesheet'), icon: Clock3, onSelect: choose(() => navigate('/my-time')), shown: true },
        { key: 'expense', label: t('Expense'), icon: ReceiptText, onSelect: choose(() => setDialog('expense')), shown: true },
        { key: 'sprint', label: t('Sprint'), icon: Timer, onSelect: choose(() => setDialog('sprint')), shown: delivery },
        { key: 'meeting', label: t('Meeting'), icon: CalendarClock, onSelect: choose(() => setDialog('meeting')), shown: true },
        { key: 'news', label: t('Announcement'), icon: Megaphone, onSelect: choose(() => setDialog('news')), shown: true },
        // A wiki page is made inside a tree, at a place: this opens the wiki.
        { key: 'wiki', label: t('Wiki page'), icon: BookOpen, onSelect: choose(() => navigate('/wiki')), shown: true },
      ],
    },
    {
      key: 'apps',
      title: t('Apps'),
      tiles: [
        {
          key: 'portfolio-status',
          label: t('Portfolio status'),
          icon: SlidersHorizontal,
          onSelect: choose(() => setDialog('portfolio-status')),
          shown: can('portfolios:manage') || can('health:manage'),
        },
        {
          key: 'project-status',
          label: t('Project status'),
          icon: SlidersVertical,
          onSelect: choose(() => setDialog('project-status')),
          shown: canAnywhere('project:edit'),
        },
        {
          key: 'project-request',
          label: t('Project request'),
          icon: FilePlus2,
          onSelect: choose(() => setDialog('project-request')),
          shown: true,
        },
        {
          key: 'stage-gate',
          label: t('Stage gate approval'),
          icon: DoorOpen,
          onSelect: choose(() => setDialog('stage-gate')),
          shown: canAnywhere('project:edit'),
        },
        {
          key: 'risk',
          label: t('Risk'),
          icon: ShieldAlert,
          onSelect: choose(() => setDialog('risk')),
          shown: delivery && canAnywhere('task:create') && (riskSetup.data?.configured ?? false),
        },
      ],
    },
    {
      key: 'people',
      title: t('People'),
      tiles: [
        {
          key: 'client',
          label: t('Client'),
          icon: Briefcase,
          onSelect: choose(() => setDialog('client')),
          shown: can('teams:manage'),
        },
      ],
    },
  ];

  const visible = sections
    .map((section) => ({ ...section, tiles: section.tiles.filter((tile) => tile.shown) }))
    .filter((section) => section.tiles.length > 0);

  const close = (next: boolean) => {
    if (!next) setDialog(undefined);
  };

  let mounted: ReactNode = null;
  switch (dialog) {
    case 'meeting':
      mounted = <MeetingDialog open onOpenChange={close} />;
      break;
    case 'news':
      mounted = <NewsDialog open onOpenChange={close} />;
      break;
    case 'expense':
      mounted = <ClaimDialog open onOpenChange={close} />;
      break;
    case 'risk':
      mounted = <RiskDialog open onOpenChange={close} typeIds={riskSetup.data?.typeIds ?? []} />;
      break;
    case 'client':
      mounted = <TeamDialog open onOpenChange={close} defaultKind="client" />;
      break;
    case 'project-status':
      mounted = <StatusReportDialog open onOpenChange={close} scopeKind="project" />;
      break;
    case 'portfolio-status':
      mounted = <StatusReportDialog open onOpenChange={close} scopeKind="portfolio" />;
      break;
    case 'project-request':
      mounted = <ProjectRequestDialog open onOpenChange={close} />;
      break;
    case 'stage-gate':
      mounted = <GateReviewDialog open onOpenChange={close} />;
      break;
    default:
      mounted = null;
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" className="shrink-0" aria-haspopup="dialog">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">{t('Create')}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[23rem] max-w-[calc(100vw-1.5rem)] p-2" aria-label={t('Create new')}>
          {visible.map((section, index) => (
            <div key={section.key} className={cn(index > 0 && 'mt-1 border-t border-border pt-2')}>
              {section.title ? <p className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">{section.title}</p> : null}
              <div className="grid grid-cols-3 gap-1">
                {section.tiles.map((tile) => (
                  <button
                    key={tile.key}
                    type="button"
                    onClick={tile.onSelect}
                    className={cn(
                      'flex h-[5.25rem] flex-col items-center justify-center gap-2 rounded-lg px-1.5 text-center text-xs font-medium text-foreground transition-colors',
                      'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    )}
                  >
                    <tile.icon className="h-5 w-5 text-muted-foreground" aria-hidden />
                    <span className="line-clamp-2 leading-tight">{tile.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </PopoverContent>
      </Popover>

      <Suspense fallback={null}>{mounted}</Suspense>
      <ProjectDialog open={dialog === 'project'} onOpenChange={close} />
      <SprintDialog
        open={dialog === 'sprint'}
        onOpenChange={close}
        onCreated={(sprint) => navigate(`/agile?sprint=${sprint.id}`)}
      />
    </>
  );
}
