import { useCallback, useEffect, useRef, useState } from 'react';
import { SendHorizontal, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { InfoTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** The composer grows with the draft, from one line up to this many. */
const MAX_ROWS = 6;
const LINE_HEIGHT_PX = 20;
const VERTICAL_PADDING_PX = 16;

interface AssistantComposerProps {
  disabled?: boolean;
  streaming?: boolean;
  /** Text to place in the draft (a prompt handed over from elsewhere). */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  autoFocus?: boolean;
}

export function AssistantComposer({
  disabled = false,
  streaming = false,
  prefill,
  onPrefillConsumed,
  onSend,
  onStop,
  autoFocus = false,
}: AssistantComposerProps) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fit = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const max = MAX_ROWS * LINE_HEIGHT_PX + VERTICAL_PADDING_PX;
    element.style.height = `${Math.min(element.scrollHeight, max)}px`;
    element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden';
  }, []);

  useEffect(fit, [draft, fit]);

  useEffect(() => {
    if (!prefill) return;
    setDraft(prefill);
    onPrefillConsumed?.();
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    });
  }, [prefill, onPrefillConsumed]);

  useEffect(() => {
    if (autoFocus && !disabled) {
      // The popup is still scaling in when this mounts; focus once it has
      // landed, so the caret is not painted mid-animation.
      const timer = setTimeout(() => textareaRef.current?.focus(), 200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [autoFocus, disabled]);

  const canSend = draft.trim().length > 0 && !disabled && !streaming;

  const submit = () => {
    if (!canSend) return;
    onSend(draft);
    setDraft('');
  };

  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div
        className={cn(
          'flex items-end gap-1.5 rounded-xl border border-input bg-surface p-1.5 shadow-xs transition-colors',
          'focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/25',
          disabled && 'opacity-60',
        )}
      >
        <Textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          disabled={disabled}
          placeholder={disabled ? 'The assistant is unavailable' : 'Ask about your work…'}
          aria-label="Message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="min-h-0 resize-none border-0 bg-transparent px-2 py-2 leading-5 shadow-none focus-visible:border-0 focus-visible:ring-0"
        />
        {streaming ? (
          <InfoTooltip label="Stop generating">
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              onClick={onStop}
              aria-label="Stop generating"
              className="shrink-0"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          </InfoTooltip>
        ) : (
          <Button
            type="submit"
            size="icon-sm"
            disabled={!canSend}
            aria-label="Send message"
            className="shrink-0"
          >
            <SendHorizontal className="h-4 w-4" />
          </Button>
        )}
      </div>
      <p className="px-1 text-2xs text-muted-foreground">
        Answers are generated from EPM data you can access. Check important figures.
      </p>
    </form>
  );
}
