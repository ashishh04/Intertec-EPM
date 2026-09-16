import type { FastifyPluginAsync } from 'fastify';

import { EpmError } from '../lib/errors.js';
import { getPreferences, preferencesPatchSchema, setPreferences } from '../email/preferences.js';

/**
 * A person's own settings.
 *
 * Always the caller's: the id comes from the session and never from the
 * request, so there is no way to read or write anyone else's. A body of any
 * subset of sections is merged over what is stored, which is merged over the
 * defaults — the Settings page can save one switch at a time and always gets
 * the complete document back.
 */
export const preferencesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/preferences', async (request) => {
    const userId = request.auth?.userId;
    if (!userId) throw EpmError.unauthorized();

    return getPreferences(userId);
  });

  app.put<{ Body: unknown }>('/preferences', async (request) => {
    const userId = request.auth?.userId;
    if (!userId) throw EpmError.unauthorized();

    // A ZodError is answered as 400 with the offending paths by the app's
    // error handler; nothing to translate here.
    const patch = preferencesPatchSchema.parse(request.body ?? {});

    return setPreferences(userId, patch);
  });
};
