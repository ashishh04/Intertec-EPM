import type { FastifyPluginAsync } from 'fastify';

import { EpmError } from '../lib/errors.js';
import { requestSignal } from '../lib/request-signal.js';
import { getCurrentUser, getUsers } from '../mapping/users.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request) => getCurrentUser(requestSignal(request)));

  app.get('/users', async (request) => getUsers(requestSignal(request)));

  app.get<{ Params: { id: string } }>('/users/:id', async (request) => {
    const users = await getUsers(requestSignal(request));
    const user = users.find((candidate) => candidate.id === request.params.id);
    if (!user) throw EpmError.notFound('That person');
    return user;
  });
};
