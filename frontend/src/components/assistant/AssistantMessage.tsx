import { Check, CircleAlert, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EpmMark } from '@/components/common/EpmLogo';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Markdown } from './Markdown';
import { cn } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';
import type { AssistantMessage as AssistantMessageModel, AssistantToolCall } from '@/types';

/** What the assistant looked up on the way to an answer, as a row of chips. */
function ToolCallChips({ calls }: { calls: AssistantToolCall[] }) {
  if (calls.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Data the assistant consulted">
      {calls.map((call) => (
        <li key={call.id}>
          <Badge
            size="sm"
            tone={call.status === 'failed' ? 'danger' : call.status === 'done' ? 'success' : 'neutral'}
            className="gap-1 font-normal"
          >
            {call.status === 'running' ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : call.status === 'done' ? (
              <Check className="h-3 w-3" aria-hidden />
            ) : (
              <CircleAlert className="h-3 w-3" aria-hidden />
            )}
            {call.label}
            <span className="sr-only">
              {call.status === 'running'
                ? ', in progress'
                : call.status === 'done'
                  ? ', done'
                  : ', failed'}
            </span>
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** Blinking insertion point that marks the reply as still arriving. */
function StreamingCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1em] w-0.5 translate-y-[0.15em] animate-pulse rounded-full bg-foreground/70"
    />
  );
}

interface AssistantMessageProps {
  message: AssistantMessageModel;
  /** The reply is still arriving: show the caret and keep the chips live. */
  streaming?: boolean;
}

export function AssistantMessage({ message, streaming = false }: AssistantMessageProps) {
  const { user } = useAuth();

  if (message.role === 'user') {
    return (
      <div className="flex items-end justify-end gap-2 pl-10">
        <div className="max-w-full rounded-xl rounded-br-sm bg-primary-soft px-3.5 py-2 text-sm leading-relaxed text-foreground">
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
        <UserAvatar user={user} size="xs" className="mb-0.5" />
      </div>
    );
  }

  const waiting = streaming && !message.content;

  return (
    <div className="flex items-start gap-2.5 pr-6">
      <EpmMark className="mt-0.5 h-6 w-6 shrink-0 rounded-md" />
      <div className={cn('min-w-0 flex-1 space-y-2', waiting && 'pt-1')}>
        <ToolCallChips calls={message.toolCalls} />
        {waiting ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {message.toolCalls.some((call) => call.status === 'running')
              ? 'Looking that up…'
              : 'Thinking…'}
          </p>
        ) : (
          <Markdown content={message.content} trailing={streaming ? <StreamingCaret /> : null} />
        )}
      </div>
    </div>
  );
}
