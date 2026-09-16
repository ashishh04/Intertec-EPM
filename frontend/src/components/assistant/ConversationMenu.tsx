import { useState } from 'react';
import { Check, History, SquarePen, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoTooltip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useAssistantConversations, useDeleteAssistantConversation } from '@/hooks/useAssistant';
import { cn, formatRelative, truncate } from '@/lib/utils';
import type { AssistantConversation, ID } from '@/types';

/** The switcher lists this many; older ones are reachable once these go. */
const RECENT_LIMIT = 12;

interface ConversationMenuProps {
  activeId: ID | null;
  enabled: boolean;
  onSelect: (id: ID) => void;
  onNew: () => void;
}

/**
 * Recent conversations with a way back to any of them, a fresh start, and a
 * bin. Deleting asks first — a chat is easy to lose and awkward to recreate.
 */
export function ConversationMenu({ activeId, enabled, onSelect, onNew }: ConversationMenuProps) {
  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AssistantConversation | null>(null);
  const { data: conversations } = useAssistantConversations(enabled);
  const remove = useDeleteAssistantConversation();

  const recent = (conversations ?? []).slice(0, RECENT_LIMIT);

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    remove.mutate(target.id, {
      onSuccess: () => {
        setPendingDelete(null);
        if (target.id === activeId) onNew();
        toast.success('Conversation deleted');
      },
      onError: (error) =>
        toast.error('Could not delete the conversation', {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <InfoTooltip label="Conversations">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Conversations"
              disabled={!enabled}
            >
              <History className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </InfoTooltip>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onSelect={onNew}>
            <SquarePen />
            New conversation
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Recent</DropdownMenuLabel>
          {recent.length === 0 ? (
            <p className="px-2 pb-1.5 pt-0.5 text-2xs text-muted-foreground">
              Nothing yet. Your conversations will be listed here.
            </p>
          ) : (
            recent.map((conversation) => {
              const active = conversation.id === activeId;
              return (
                <DropdownMenuItem
                  key={conversation.id}
                  onSelect={() => onSelect(conversation.id)}
                  className={cn('group items-start gap-2', active && 'bg-muted/60')}
                  aria-current={active ? 'true' : undefined}
                >
                  <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {active ? <Check className="text-primary" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">
                      {truncate(conversation.title || 'Untitled conversation', 60)}
                    </span>
                    <span className="block text-2xs text-muted-foreground">
                      {formatRelative(conversation.updatedAt)}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Delete "${conversation.title}"`}
                    className="-mr-0.5 mt-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-danger-soft hover:text-danger-strong focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpen(false);
                      setPendingDelete(conversation);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuItem>
              );
            })
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title="Delete this conversation?"
        description={
          pendingDelete
            ? `"${truncate(pendingDelete.title || 'Untitled conversation', 80)}" and its messages will be removed. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete"
        tone="danger"
        pending={remove.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}
