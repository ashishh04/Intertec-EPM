import { apiClient, ApiError } from './client';
import { env } from '@/config/env';
import type {
  AssistantConversation,
  AssistantMessage,
  AssistantStatus,
  AssistantStreamEvent,
  ID,
} from '@/types';

/**
 * Pragnya, the in-app assistant, served by the EPM backend.
 *
 * Reads go through `apiClient` like every other domain. The chat itself is a
 * server-sent event stream, which `apiClient` cannot carry (it expects one
 * JSON body), so `streamChat` uses `fetch` directly with the same session
 * cookie and reads the body frame by frame.
 */

export interface AssistantChatInput {
  conversationId?: ID;
  message: string;
}

export interface AssistantStreamHandlers {
  onEvent: (event: AssistantStreamEvent) => void;
}

export function getStatus(): Promise<AssistantStatus> {
  return apiClient.get<AssistantStatus>('/assistant/status');
}

export function listConversations(): Promise<AssistantConversation[]> {
  return apiClient.get<AssistantConversation[]>('/assistant/conversations');
}

export function getConversation(
  id: ID,
): Promise<{ conversation: AssistantConversation; messages: AssistantMessage[] }> {
  return apiClient.get(`/assistant/conversations/${id}`);
}

export async function deleteConversation(id: ID): Promise<void> {
  await apiClient.delete<void>(`/assistant/conversations/${id}`);
}

/** Split buffered SSE text into complete frames, returning what is left over. */
function drainFrames(buffer: string, emit: (frame: string) => void): string {
  // Frames end with a blank line. Normalise CRLF so a proxy that rewrites
  // line endings does not stall the parser.
  const normalised = buffer.replace(/\r\n/g, '\n');
  const parts = normalised.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) emit(part);
  return rest;
}

function parseFrame(frame: string): AssistantStreamEvent | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data) as AssistantStreamEvent;
  } catch {
    return null;
  }
}

/**
 * Send one message and stream the reply. Resolves once the stream closes;
 * rejects with an `ApiError` if the request is refused before streaming
 * starts (503 when the assistant is not configured). Aborting the signal
 * resolves quietly — stopping a reply is not a failure.
 */
export async function streamChat(
  input: AssistantChatInput,
  handlers: AssistantStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${env.apiBaseUrl}/assistant/chat`, {
      method: 'POST',
      credentials: 'include',
      signal,
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    throw new ApiError(
      'Unable to reach the EPM backend. Check your connection and try again.',
      0,
      'NETWORK',
    );
  }

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    let code: string | undefined;
    try {
      const payload = (await response.json()) as { message?: string; code?: string };
      message = payload.message ?? message;
      code = payload.code;
    } catch {
      // Non-JSON error body — keep the status-based message.
    }
    throw new ApiError(message, response.status, code);
  }

  if (!response.body) {
    throw new ApiError('The assistant returned an empty reply.', 502, 'EMPTY_STREAM');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const emit = (frame: string) => {
    const event = parseFrame(frame);
    if (event) handlers.onEvent(event);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainFrames(buffer, emit);
    }
    buffer += decoder.decode();
    if (buffer.trim()) drainFrames(`${buffer}\n\n`, emit);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    throw new ApiError('The reply was interrupted. Try again.', 0, 'STREAM');
  } finally {
    reader.releaseLock();
  }
}

export const assistantService = {
  getStatus,
  listConversations,
  getConversation,
  deleteConversation,
  streamChat,
};
