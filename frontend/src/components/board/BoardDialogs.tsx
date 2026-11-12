import { useEffect, useState } from 'react';
import { CircleDot, FolderTree, GitBranch, LayoutList, Milestone, Search, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useBoardColumnOptions } from '@/hooks/useBoards';
import { useDebounce } from '@/hooks/useDebounce';
import { useTasks } from '@/hooks/useTasks';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { BoardKind, EpmBoardColumn, EpmBoardSummary, EpmTask, ID } from '@/types';

/** Each kind's name, what its columns are, and an icon. */
export const BOARD_KINDS: { kind: BoardKind; icon: LucideIcon; label: () => string; description: () => string }[] = [
  { kind: 'basic', icon: LayoutList, label: () => t('Basic'), description: () => t('Lists you fill by hand, in the order you put things in.') },
  { kind: 'status', icon: CircleDot, label: () => t('Status'), description: () => t('A column per status. Moving a card changes its status.') },
  { kind: 'assignee', icon: Users, label: () => t('Assignee'), description: () => t('A column per person. Moving a card hands the task over.') },
  { kind: 'version', icon: Milestone, label: () => t('Version'), description: () => t('A column per version or sprint. Moving a card plans it there.') },
  { kind: 'subproject', icon: FolderTree, label: () => t('Sub-project'), description: () => t('A column per sub-project. Moving a card moves the task there.') },
  { kind: 'subtasks', icon: GitBranch, label: () => t('Parent-child'), description: () => t('A column per parent task, holding its children. Moving a card gives it that parent.') },
];

export const boardKindLabel = (kind: BoardKind) => BOARD_KINDS.find((entry) => entry.kind === kind)?.label() ?? kind;

const errorText = (error: unknown) => (error instanceof Error ? error.message : undefined);

/** A new board: its name and kind. */
export function NewBoardDialog({
  open,
  onOpenChange,
  pending,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onCreate: (input: { name: string; kind: BoardKind }) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<BoardKind>('basic');
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setName('');
    setKind('basic');
    setProblem(undefined);
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return setProblem(t('A name is required.'));
    setProblem(undefined);
    await onCreate({ name: name.trim(), kind }).catch((error) => setProblem(errorText(error) ?? t('The board could not be created.')));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('New board')}</DialogTitle>
          <DialogDescription>{t('Choose what its columns stand for. A basic board’s lists are filled by hand.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="board-name" required>
              {t('Name')}
            </Label>
            <Input id="board-name" value={name} maxLength={255} autoFocus onChange={(event) => setName(event.target.value)} />
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium">{t('Kind')}</legend>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t('Kind')}>
              {BOARD_KINDS.map((entry) => {
                const Icon = entry.icon;
                const chosen = entry.kind === kind;
                return (
                  <button
                    key={entry.kind}
                    type="button"
                    role="radio"
                    aria-checked={chosen}
                    onClick={() => setKind(entry.kind)}
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border p-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      chosen ? 'border-primary bg-primary-soft/50' : 'border-border hover:border-primary/40',
                    )}
                  >
                    <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', chosen ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">{entry.label()}</span>
                      <span className="block text-2xs leading-snug text-muted-foreground">{entry.description()}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button loading={pending} onClick={submit}>
            {t('Create board')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Renames a board. */
export function RenameBoardDialog({
  open,
  onOpenChange,
  board,
  pending,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board?: EpmBoardSummary;
  pending: boolean;
  onRename: (name: string) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setName(board?.name ?? '');
    setProblem(undefined);
  }, [open, board?.name]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Rename the board')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5 py-1">
          <Label htmlFor="board-rename" required>
            {t('Name')}
          </Label>
          <Input id="board-rename" value={name} maxLength={255} autoFocus onChange={(event) => setName(event.target.value)} />
          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button
            loading={pending}
            onClick={() => {
              if (!name.trim()) return setProblem(t('A name is required.'));
              void onRename(name.trim()).catch((error) => setProblem(errorText(error) ?? t('That could not be changed')));
            }}
          >
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A new column: a named list on a basic board; on the others, the value it
 * stands for, chosen from those not on the board yet.
 */
export function AddColumnDialog({
  open,
  onOpenChange,
  board,
  pending,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board?: EpmBoardSummary;
  pending: boolean;
  onAdd: (input: { name?: string; value?: ID }) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState<string>();
  const debounced = useDebounce(search, 250);
  const basic = board?.kind === 'basic';
  const options = useBoardColumnOptions(board?.id, board?.kind === 'subtasks' ? debounced : '', open && !basic);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSearch('');
    setProblem(undefined);
  }, [open]);

  const add = (input: { name?: string; value?: ID }) =>
    void onAdd(input).catch((error) => setProblem(errorText(error) ?? t('The column could not be added.')));

  // Filtered here for every kind but parent-child, whose tasks the server searches.
  const needle = search.trim().toLowerCase();
  const shown = (options.data ?? []).filter(
    (option) => board?.kind === 'subtasks' || !needle || option.label.toLowerCase().includes(needle) || option.detail?.toLowerCase().includes(needle),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{basic ? t('Add a list') : t('Add a column')}</DialogTitle>
          <DialogDescription>
            {basic
              ? t('A list holds the tasks you put in it, in your order.')
              : t('Choose what the column stands for. Moving a card into it gives the task that value.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          {basic ? (
            <div className="space-y-1.5">
              <Label htmlFor="list-name" required>
                {t('Name')}
              </Label>
              <Input id="list-name" value={name} maxLength={255} autoFocus onChange={(event) => setName(event.target.value)} />
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={search}
                  autoFocus
                  className="ps-8"
                  placeholder={board?.kind === 'subtasks' ? t('Search tasks by title or number') : t('Search')}
                  aria-label={t('Search')}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <ul className="epm-scroll max-h-72 space-y-1 overflow-y-auto" aria-busy={options.isFetching}>
                {shown.map((option) => (
                  <li key={option.value}>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => add({ value: option.value })}
                      className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-start text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <span className="min-w-0 truncate" dir="auto">
                        {option.label}
                      </span>
                      {option.detail ? <span className="shrink-0 font-mono text-2xs text-muted-foreground">{option.detail}</span> : null}
                    </button>
                  </li>
                ))}
                {!options.isFetching && shown.length === 0 ? (
                  <li className="px-2.5 py-4 text-center text-xs text-muted-foreground">
                    {t('Nothing left to add: every choice has a column already.')}
                  </li>
                ) : null}
              </ul>
            </>
          )}
          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          {basic ? (
            <Button
              loading={pending}
              onClick={() => {
                if (!name.trim()) return setProblem(t('A name is required.'));
                add({ name: name.trim() });
              }}
            >
              {t('Add the list')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Puts one of the project's tasks on a basic board's list. */
export function AddCardDialog({
  open,
  onOpenChange,
  projectId,
  column,
  pending,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: ID;
  column?: EpmBoardColumn;
  pending: boolean;
  onAdd: (task: EpmTask) => Promise<unknown>;
}) {
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState<string>();
  const debounced = useDebounce(search, 250);
  const found = useTasks({ projectId, search: debounced || undefined, pageSize: 20 }, { enabled: open });
  const onList = new Set((column?.cards ?? []).map((card) => card.id));

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setProblem(undefined);
  }, [open]);

  const tasks = (found.data?.items ?? []).filter((task) => !onList.has(task.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Add a task to {status}', { status: column?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('It goes at the end of the list. Drag it to its place.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="relative">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              autoFocus
              className="ps-8"
              placeholder={t('Search tasks by title or number')}
              aria-label={t('Search')}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <ul className="epm-scroll max-h-72 space-y-1 overflow-y-auto" aria-busy={found.isFetching}>
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void onAdd(task).catch((error) => setProblem(errorText(error) ?? t('That could not be changed')))}
                  className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-start text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">{task.key}</span>
                  <span className="min-w-0 truncate" dir="auto">
                    {task.subject}
                  </span>
                </button>
              </li>
            ))}
            {!found.isFetching && tasks.length === 0 ? (
              <li className="px-2.5 py-4 text-center text-xs text-muted-foreground">{t('No tasks match.')}</li>
            ) : null}
          </ul>
          {problem ? <Alert tone="danger">{problem}</Alert> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
