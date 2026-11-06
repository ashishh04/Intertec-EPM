import { env } from '../config/env.js';
import type { EpmProject } from '../types/epm.js';
import type { ToolContext } from './tools.js';

/**
 * What both tool files need: EPM's API called as the person asking, and the
 * project a question names turned into the one the API wants. In a module of
 * their own because `tools.ts` lists the analysis tools, so those could not
 * import it without a cycle.
 */

/**
 * Failure the model can read: the message is what the API said, which is
 * already written for a person. Distinct from other errors so the service can
 * hand it to the model as a tool result instead of ending the conversation.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * GET through the API as the caller.
 *
 * `inject` is inherited from the root instance, so calling it on the plugin's
 * own `app` still routes through the root: every onRequest and preHandler
 * hook, the session lookup, the async credential context, all of it.
 */
export async function callApi<T>(
  context: ToolContext,
  path: string,
  query: Record<string, string | undefined> = {},
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : '';

  const response = await context.app.inject({
    method: 'GET',
    url: `${env.API_PREFIX}${path}${suffix}`,
    headers: { cookie: context.request.headers.cookie ?? '' },
  });

  if (response.statusCode >= 400) {
    let message = `That request failed (${response.statusCode}).`;
    try {
      const body = response.json<{ message?: string }>();
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // Not JSON; the generic sentence stands.
    }
    throw new ToolError(message);
  }

  return response.json<T>();
}

/** "Project Falcon" and "the Falcon project" are how people speak of a project called Falcon. */
const PROJECT_WORD = /^(?:the\s+)?(?:project\s+)?|\s+project$|^مشروع\s+/giu;

/**
 * The project a name means, and whatever else it could have meant. Nothing
 * matching is a failure the model reads, and absence is all it learns from it.
 */
export async function projectNamed(context: ToolContext, name: string): Promise<{ project: EpmProject; others: EpmProject[] }> {
  const bare = name.replace(PROJECT_WORD, '').trim();
  let candidates = await callApi<EpmProject[]>(context, '/projects', { search: name });
  if (candidates.length === 0 && bare !== '' && bare !== name) {
    candidates = await callApi<EpmProject[]>(context, '/projects', { search: bare });
  }

  const wanted = new Set([name.toLowerCase(), bare.toLowerCase()]);
  const project =
    candidates.find((candidate) => wanted.has(candidate.name.toLowerCase())) ??
    candidates.find((candidate) => wanted.has(candidate.identifier.toLowerCase())) ??
    candidates[0];
  if (!project) throw new ToolError(`No project matches “${name}”.`);

  return { project, others: candidates.filter((candidate) => candidate.id !== project.id) };
}

/**
 * The id of a project the model named either way.
 *
 * A question says "Project Falcon", the APIs want a number, and the model often
 * has no number yet: a name sent as an id came back refused, so the answer began
 * with a failed lookup, a list of every project and the same lookup again. Every
 * tool that takes a project takes its name too, and the failure never happens.
 */
export async function projectIdFrom(context: ToolContext, value: unknown): Promise<string | undefined> {
  const reference = typeof value === 'string' ? value.trim() : '';
  if (reference === '') return undefined;
  if (/^\d+$/.test(reference)) return reference;
  return (await projectNamed(context, reference)).project.id;
}
