import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db/prisma.js';
import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { status as assistantStatus, isConfigured } from '../assistant/bedrock.js';
import { chat, toConversation, toMessage } from '../assistant/service.js';
import type { AssistantStreamEvent } from '../types/epm.js';

/**
 * Pragnya, the EPM assistant.
 *
 * Conversations are the caller's own: every query filters on the session's
 * user id, so another person's id reads as not found rather than as theirs.
 *
 * The chat endpoint streams. It is the one place in the API that writes to
 * the raw response, because the model's answer arrives a few words at a time
 * and holding it back until the end would make the assistant feel broken
 * for the ten seconds a tool-using answer can take.
 */

const chatBody = z.object({
  conversationId: z.string().min(1).optional(),
  message: z.string().trim().min(1, 'Ask something.').max(4_000, 'That is too long to ask.'),
});

/** Most conversations the sidebar lists. */
const CONVERSATION_LIMIT = 30;

function writeFrame(reply: FastifyReply, event: AssistantStreamEvent): void {
  if (reply.raw.writableEnded || reply.raw.destroyed) return;
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

export const assistantRoutes: FastifyPluginAsync = async (app) => {
  app.get('/assistant/status', async () => assistantStatus());

  app.get('/assistant/conversations', async (request) => {
    const rows = await prisma.assistantConversation.findMany({
      where: { userId: request.auth?.userId ?? '' },
      orderBy: { updatedAt: 'desc' },
      take: CONVERSATION_LIMIT,
    });
    return rows.map(toConversation);
  });

  app.get<{ Params: { id: string } }>('/assistant/conversations/:id', async (request) => {
    const conversation = await prisma.assistantConversation.findFirst({
      where: { id: request.params.id, userId: request.auth?.userId ?? '' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) throw EpmError.notFound('That conversation');

    return {
      conversation: toConversation(conversation),
      messages: conversation.messages.map(toMessage),
    };
  });

  app.delete<{ Params: { id: string } }>('/assistant/conversations/:id', async (request, reply) => {
    // Filtered on the owner, so deleting someone else's id removes nothing.
    const { count } = await prisma.assistantConversation.deleteMany({
      where: { id: request.params.id, userId: request.auth?.userId ?? '' },
    });
    if (count === 0) throw EpmError.notFound('That conversation');
    reply.code(204);
  });

  app.post<{ Body: unknown }>(
    '/assistant/chat',
    {
      // Each turn is several upstream calls and a model completion; the global
      // allowance is sized for page loads, not for that.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) throw EpmError.unauthorized();

      const parsed = chatBody.safeParse(request.body);
      if (!parsed.success) {
        throw EpmError.badRequest(parsed.error.issues[0]?.message ?? 'The request was not valid.');
      }

      // Refused as ordinary JSON, before the stream starts, so the client's
      // normal error handling applies rather than a stream that ends at once.
      const status = assistantStatus();
      if (!isConfigured() || !status.available) {
        throw EpmError.unavailable(status.reason);
      }

      // Stops the upstream call when the person leaves. The request's own
      // signal watches the socket, which is the only reliable sign of that for
      // a request with a body — see lib/request-signal.ts.
      const controller = new AbortController();
      const abort = () => controller.abort();
      requestSignal(request).addEventListener('abort', abort, { once: true });
      reply.raw.once('close', () => {
        if (!reply.raw.writableEnded) abort();
      });

      // Whatever the hooks set (CORS, rate-limit headers) has to be copied
      // across: once hijacked, Fastify sends none of it.
      const inherited: Record<string, string | number | string[]> = {};
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) inherited[name] = value;
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        ...inherited,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.flushHeaders();

      await chat({
        app,
        request,
        userId,
        conversationId: parsed.data.conversationId,
        message: parsed.data.message,
        signal: controller.signal,
        emit: (event) => writeFrame(reply, event),
      });

      if (!reply.raw.writableEnded) reply.raw.end();
    },
  );
};
