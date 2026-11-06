import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { currentLanguage, t } from '@/lib/i18n';
import { assistantService } from '@/services/api/assistant';
import type {
  AssistantConversation,
  AssistantMessage,
  AssistantStreamEvent,
  AssistantToolCall,
  ID,
} from '@/types';

/**
 * Pragnya, the in-app assistant.
 *
 * Status and history are ordinary queries. The chat itself is streamed, so
 * `useChat` keeps the open conversation in local state and only hands the
 * finished exchange back to the query cache once the server has persisted it.
 */

export const assistantKeys = {
  all: ['assistant'] as const,
  status: ['assistant', 'status'] as const,
  conversations: ['assistant', 'conversations'] as const,
  // By language too: a stored answer's chips come written for whoever is reading.
  conversation: (id: ID) => ['assistant', 'conversations', id, currentLanguage()] as const,
};

interface ConversationDetail {
  conversation: AssistantConversation;
  messages: AssistantMessage[];
}

export function useAssistantStatus(enabled = true) {
  return useQuery({
    queryKey: assistantKeys.status,
    queryFn: () => assistantService.getStatus(),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useAssistantConversations(enabled = true) {
  return useQuery({
    queryKey: assistantKeys.conversations,
    queryFn: () => assistantService.listConversations(),
    enabled,
    staleTime: 30_000,
  });
}

export function useAssistantConversation(id: ID | null) {
  return useQuery({
    queryKey: assistantKeys.conversation(id ?? ''),
    queryFn: () => assistantService.getConversation(id as ID),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useDeleteAssistantConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: ID) => assistantService.deleteConversation(id),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: assistantKeys.conversation(id) });
      queryClient.invalidateQueries({ queryKey: assistantKeys.conversations });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Chat                                                                        */
/* -------------------------------------------------------------------------- */

interface UseChatOptions {
  /** Fired when the server opens a new conversation for the first message. */
  onConversation?: (conversationId: ID, title: string) => void;
}

export interface ChatState {
  messages: AssistantMessage[];
  /** True while the persisted history of a chosen conversation is loading. */
  isLoadingHistory: boolean;
  isStreaming: boolean;
  error: string | null;
  /** The last prompt that failed, so the composer can offer a retry. */
  failedPrompt: string | null;
  send: (text: string) => Promise<void>;
  stop: () => void;
  clearError: () => void;
}

function localId(prefix: string) {
  return `local-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Replace a call with the same id, or append it — a call arrives twice. */
function upsertToolCall(calls: AssistantToolCall[], call: AssistantToolCall): AssistantToolCall[] {
  const index = calls.findIndex((existing) => existing.id === call.id);
  if (index === -1) return [...calls, call];
  const next = calls.slice();
  next[index] = call;
  return next;
}

export function useChat(conversationId: ID | null, options: UseChatOptions = {}): ChatState {
  const queryClient = useQueryClient();
  const history = useAssistantConversation(conversationId);

  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedPrompt, setFailedPrompt] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const activeIdRef = useRef<ID | null>(conversationId);
  const onConversationRef = useRef(options.onConversation);
  onConversationRef.current = options.onConversation;

  useEffect(() => {
    activeIdRef.current = conversationId;
  }, [conversationId]);

  // Seed the local list from the server whenever the chosen conversation (or
  // its cached history) changes. Never while a reply is streaming: the local
  // list is ahead of the cache until `done` lands.
  useEffect(() => {
    if (streamingRef.current) return;
    if (!conversationId) {
      setMessages([]);
      return;
    }
    if (history.data) setMessages(history.data.messages);
  }, [conversationId, history.data]);

  // A reply in flight is abandoned with the panel, not left running.
  useEffect(() => () => controllerRef.current?.abort(), []);

  // Lets go at once rather than when the stream has wound down: "New
  // conversation" stops the reply and moves on in one click, and the list has to
  // be free to follow it. A stopped reply left the old thread on screen.
  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    streamingRef.current = false;
    setIsStreaming(false);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setFailedPrompt(null);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streamingRef.current) return;

      setError(null);
      setFailedPrompt(null);

      const startedIn = activeIdRef.current;
      const now = new Date().toISOString();
      const userMessage: AssistantMessage = {
        id: localId('user'),
        conversationId: startedIn ?? '',
        role: 'user',
        content: trimmed,
        toolCalls: [],
        createdAt: now,
      };
      const placeholderId = localId('assistant');
      const placeholder: AssistantMessage = {
        id: placeholderId,
        conversationId: startedIn ?? '',
        role: 'assistant',
        content: '',
        toolCalls: [],
        createdAt: now,
      };
      setMessages((previous) => [...previous, userMessage, placeholder]);

      const controller = new AbortController();
      controllerRef.current = controller;
      streamingRef.current = true;
      setIsStreaming(true);

      // Held in one object rather than `let`s: assignments happen inside the
      // event callback, which TypeScript's narrowing cannot see through. The
      // reply is kept here as well as on screen: it outlives the panel, which a
      // reply can be stopped by closing.
      const outcome: {
        conversation: ID | null;
        title: string;
        reply: Pick<AssistantMessage, 'content' | 'toolCalls'>;
        message: AssistantMessage | null;
        failure: string | null;
      } = {
        conversation: startedIn,
        title: '',
        reply: { content: '', toolCalls: [] },
        message: null,
        failure: null,
      };

      const patchPlaceholder = () => {
        const { reply } = outcome;
        setMessages((previous) =>
          previous.map((message) => (message.id === placeholderId ? { ...message, ...reply } : message)),
        );
      };

      const onEvent = (event: AssistantStreamEvent) => {
        switch (event.type) {
          case 'conversation':
            activeIdRef.current = event.conversationId;
            outcome.conversation = event.conversationId;
            outcome.title = event.title;
            // A conversation opened by this message has no history to fetch:
            // seed the cache so choosing it does not put a loading state over
            // the reply that is arriving. `done` appends the exchange below.
            queryClient.setQueryData<ConversationDetail>(
              assistantKeys.conversation(event.conversationId),
              (existing) =>
                existing ?? {
                  conversation: {
                    id: event.conversationId,
                    title: event.title,
                    createdAt: now,
                    updatedAt: now,
                  },
                  messages: [],
                },
            );
            onConversationRef.current?.(event.conversationId, event.title);
            break;
          case 'tool':
            outcome.reply = { ...outcome.reply, toolCalls: upsertToolCall(outcome.reply.toolCalls, event.call) };
            patchPlaceholder();
            break;
          case 'delta':
            outcome.reply = { ...outcome.reply, content: outcome.reply.content + event.text };
            patchPlaceholder();
            break;
          case 'done':
            outcome.message = event.message;
            break;
          case 'error':
            outcome.failure = event.message;
            break;
        }
      };

      try {
        await assistantService.streamChat(
          { conversationId: startedIn ?? undefined, message: trimmed },
          { onEvent },
          controller.signal,
        );
      } catch (caught) {
        outcome.failure = caught instanceof Error ? caught.message : t('Something went wrong.');
      }

      const aborted = controller.signal.aborted;
      const { conversation } = outcome;
      // Already let go if this was stopped, and another reply may have begun since.
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        streamingRef.current = false;
        setIsStreaming(false);
      }

      // Hand the exchange to the cache, so switching away and back does not
      // refetch (or briefly show the list from before this reply). The cached
      // list is what this one was seeded from, so appending the pair keeps the
      // two in step.
      const handToCache = (sent: AssistantMessage, reply: AssistantMessage | null) => {
        if (!conversation) return;
        queryClient.setQueryData<ConversationDetail>(
          assistantKeys.conversation(conversation),
          (existing) => ({
            conversation: existing?.conversation ?? {
              id: conversation,
              title: outcome.title || trimmed,
              createdAt: now,
              updatedAt: reply?.createdAt ?? now,
            },
            messages: [...(existing?.messages ?? []), sent, ...(reply ? [reply] : [])],
          }),
        );
      };

      if (outcome.message) {
        const persisted = outcome.message;
        const sent = { ...userMessage, conversationId: persisted.conversationId };
        setMessages((previous) =>
          previous.map((message) => {
            if (message.id === placeholderId) return persisted;
            if (message.id === userMessage.id) return sent;
            return message;
          }),
        );
        handToCache(sent, persisted);
        queryClient.invalidateQueries({ queryKey: assistantKeys.conversations, exact: true });
        return;
      }

      if (aborted) {
        // The reader chose to stop: keep whatever arrived, drop an empty bubble
        // and mark anything still "running" as not finished.
        const { content, toolCalls } = outcome.reply;
        const kept: AssistantMessage | null =
          content || toolCalls.length > 0
            ? {
                ...placeholder,
                conversationId: conversation ?? '',
                content,
                toolCalls: toolCalls.map((call) =>
                  call.status === 'running' ? { ...call, status: 'failed' as const } : call,
                ),
              }
            : null;
        setMessages((previous) =>
          previous.flatMap((message) => {
            if (message.id !== placeholderId) return [message];
            return kept ? [kept] : [];
          }),
        );
        // The list only, and exactly. Its key is also the start of each
        // conversation's, and refetching this one now reads it back before the
        // server has finished keeping the reply: the answer vanished from the
        // screen the moment it was stopped.
        handToCache({ ...userMessage, conversationId: conversation ?? '' }, kept);
        if (conversation) queryClient.invalidateQueries({ queryKey: assistantKeys.conversations, exact: true });
        return;
      }

      // Failed: take back the optimistic pair so a retry does not double it.
      setMessages((previous) =>
        previous.filter((message) => message.id !== placeholderId && message.id !== userMessage.id),
      );
      setError(outcome.failure ?? t('The assistant did not reply. Try again.'));
      setFailedPrompt(trimmed);
    },
    [queryClient],
  );

  return {
    messages,
    // Never while streaming: the live reply is the content, not the history.
    isLoadingHistory: Boolean(conversationId) && history.isLoading && !isStreaming,
    isStreaming,
    error,
    failedPrompt,
    send,
    stop,
    clearError,
  };
}
