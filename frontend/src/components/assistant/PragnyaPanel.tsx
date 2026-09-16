import { useCallback, useEffect, useRef } from 'react';
import { RotateCcw, Sparkles, SquarePen, X } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTooltip } from '@/components/ui/tooltip';
import { EpmMark } from '@/components/common/EpmLogo';
import { useUI } from '@/providers/UIProvider';
import { useAssistantStatus, useChat } from '@/hooks/useAssistant';
import { cn } from '@/lib/utils';
import type { ID } from '@/types';
import { AssistantComposer } from './AssistantComposer';
import { AssistantMessage } from './AssistantMessage';
import { ConversationMenu } from './ConversationMenu';

const SUGGESTIONS = [
  'What is overdue on my work?',
  'How healthy is each project?',
  'Who has capacity this week?',
  'Summarise the active sprint',
];

/** How close to the bottom the reader must be for new text to pull the view along. */
const STICK_THRESHOLD_PX = 48;

interface PragnyaPanelProps {
  /** Held by the widget, which outlives the popup, so closing keeps the thread. */
  conversationId: ID | null;
  onConversationChange: (id: ID | null) => void;
  onClose: () => void;
}

/**
 * The inside of the Pragnya popup: a conversation answered from the product's
 * own data. The widget owns the frame, the animation and the dialog
 * semantics; everything from the header down is here.
 */
export function PragnyaPanel({ conversationId, onConversationChange, onClose }: PragnyaPanelProps) {
  const { pragnyaPrompt, clearPragnyaPrompt } = useUI();

  // Only mounted while the popup is open, so the status check is too.
  const status = useAssistantStatus();
  const available = status.data?.available ?? false;
  const checking = status.isLoading;

  const chat = useChat(conversationId, {
    onConversation: (id) => onConversationChange(id),
  });
  const { messages, isStreaming, isLoadingHistory, error, failedPrompt, send, stop, clearError } =
    chat;

  const startNew = useCallback(() => {
    if (isStreaming) stop();
    clearError();
    onConversationChange(null);
  }, [isStreaming, stop, clearError, onConversationChange]);

  const switchTo = useCallback(
    (id: ID) => {
      if (id === conversationId) return;
      if (isStreaming) stop();
      clearError();
      onConversationChange(id);
    },
    [conversationId, isStreaming, stop, clearError, onConversationChange],
  );

  // Follow the reply as it arrives, unless the reader has scrolled up to reread.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !stickRef.current) return;
    element.scrollTo({ top: element.scrollHeight });
  }, [messages, isStreaming]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    stickRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD_PX;
  };

  const ask = (text: string) => {
    stickRef.current = true;
    void send(text);
  };

  const inputDisabled = checking || !available;
  const showIntro = !isLoadingHistory && messages.length === 0;

  return (
    <>
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <EpmMark className="h-6 w-6 shrink-0" />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <h2 className="text-sm font-semibold tracking-tight">Pragnya</h2>
          <Badge size="sm" tone="highlight">
            Beta
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <InfoTooltip label="New conversation">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New conversation"
              onClick={startNew}
              disabled={!available || (messages.length === 0 && conversationId === null)}
            >
              <SquarePen className="h-4 w-4" />
            </Button>
          </InfoTooltip>
          <ConversationMenu
            activeId={conversationId}
            enabled={available}
            onSelect={switchTo}
            onNew={startNew}
          />
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="epm-scroll relative min-h-0 flex-1 overflow-y-auto"
      >
        {checking ? (
          <div className="space-y-3 p-4" aria-busy>
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : null}

        {!checking && !available ? (
          <div className="p-3">
            <Alert tone="warning" title="The assistant is not available">
              {status.error
                ? 'EPM could not check whether the assistant is configured. Try again in a moment.'
                : (status.data?.reason ??
                  'It has not been configured for this environment. Ask an administrator to connect it.')}
            </Alert>
          </div>
        ) : null}

        {!checking && available && isLoadingHistory ? (
          <div className="space-y-4 p-4" aria-busy>
            <div className="flex justify-end">
              <Skeleton className="h-9 w-2/3 rounded-xl" />
            </div>
            <div className="flex gap-2.5">
              <Skeleton className="h-6 w-6 rounded-md" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          </div>
        ) : null}

        {!checking && available && showIntro ? (
          <Intro onPick={ask} disabled={inputDisabled || isStreaming} />
        ) : null}

        {!checking && available && !isLoadingHistory && messages.length > 0 ? (
          <ol className="space-y-4 px-3.5 py-4" aria-live="polite" aria-busy={isStreaming}>
            {messages.map((message, index) => (
              <li key={message.id}>
                <AssistantMessage
                  message={message}
                  streaming={
                    isStreaming && index === messages.length - 1 && message.role === 'assistant'
                  }
                />
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      {/* Composer */}
      <div className="shrink-0 space-y-2 border-t border-border bg-surface px-3 py-2.5">
        {error ? (
          <Alert
            tone="danger"
            actions={
              failedPrompt ? (
                <Button size="sm" variant="secondary" onClick={() => ask(failedPrompt)}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={clearError}>
                  Dismiss
                </Button>
              )
            }
          >
            {error}
          </Alert>
        ) : null}
        <AssistantComposer
          disabled={inputDisabled}
          streaming={isStreaming}
          prefill={pragnyaPrompt}
          onPrefillConsumed={clearPragnyaPrompt}
          onSend={ask}
          onStop={stop}
          autoFocus
        />
      </div>
    </>
  );
}

function Intro({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 pb-6 pt-8 text-center">
      <span
        className="flex h-10 w-10 items-center justify-center rounded-full bg-highlight-soft text-highlight"
        aria-hidden
      >
        <Sparkles className="h-5 w-5" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">What would you like to know?</p>
        <p className="mx-auto max-w-[17rem] text-xs text-muted-foreground">
          Ask about your projects, tasks, sprints and people. Answers come from EPM&apos;s own data.
        </p>
      </div>
      <ul className="mt-1 flex w-full flex-col gap-2" aria-label="Suggested questions">
        {SUGGESTIONS.map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(suggestion)}
              className={cn(
                'w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-left text-xs text-foreground shadow-xs transition-colors',
                'hover:border-primary/30 hover:bg-primary-soft/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {suggestion}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
