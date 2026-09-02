import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * An AbortSignal tied to the client connection.
 *
 * Several routes fan out into a handful of OpenProject calls. When the browser
 * navigates away mid-request those calls should stop rather than continue
 * consuming upstream capacity, and Node's IncomingMessage exposes no signal of
 * its own.
 *
 * The signal is created once per request by `registerRequestSignal` rather than
 * derived on demand. Deriving it from `request.raw`'s `close` event looks
 * equivalent but is not: for a request that carries a body, `close` fires as
 * soon as the body has been read — before the handler runs — so every POST and
 * PATCH aborted itself a tick after starting. Listening to the socket instead
 * distinguishes "the body finished arriving" from "the client went away".
 */

declare module 'fastify' {
  interface FastifyRequest {
    abortController?: AbortController;
  }
}

/** Never-aborting fallback, for requests created outside the HTTP lifecycle. */
const NEVER = new AbortController().signal;

export function requestSignal(request: FastifyRequest): AbortSignal {
  return request.abortController?.signal ?? NEVER;
}

export function registerRequestSignal(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    const controller = new AbortController();
    request.abortController = controller;

    const socket = request.raw.socket;
    if (!socket) return done();

    const abort = () => controller.abort();
    // Only a dead connection counts as a cancellation.
    socket.once('close', abort);

    // Keep-alive reuses one socket across requests, so the listener has to come
    // off when the response ends or they accumulate for the socket's lifetime.
    const release = () => socket.removeListener('close', abort);
    reply.raw.once('finish', release);
    reply.raw.once('close', release);

    done();
  });
}
