/**
 * Error envelope.
 *
 * The frontend's ApiClient parses `{ message, code, details }` off any non-2xx
 * response (see frontend/src/services/api/client.ts). Every error leaving this
 * service must match that shape or the UI falls back to a generic status string.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'GONE'
  | 'VALIDATION_FAILED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT'
  | 'INTERNAL';

export interface ErrorBody {
  message: string;
  code: ErrorCode;
  details?: unknown;
}

export class EpmError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** Set when the failure originated upstream; logged, never sent to the client. */
  readonly upstream?: unknown;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options: { details?: unknown; upstream?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'EpmError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.upstream = options.upstream;
  }

  toBody(): ErrorBody {
    return this.details === undefined
      ? { message: this.message, code: this.code }
      : { message: this.message, code: this.code, details: this.details };
  }

  static badRequest(message: string, details?: unknown) {
    return new EpmError(400, 'BAD_REQUEST', message, { details });
  }

  static unauthorized(message = 'Your session has expired. Please sign in again.') {
    return new EpmError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You do not have access to this resource.') {
    return new EpmError(403, 'FORBIDDEN', message);
  }

  static notFound(what = 'The requested resource') {
    return new EpmError(404, 'NOT_FOUND', `${what} could not be found.`);
  }

  /**
   * The request clashes with what is already there — a duplicate name, or an
   * action that has already been taken. Distinct from a validation failure:
   * the request is well formed and would have worked a moment ago.
   */
  static conflict(message: string) {
    return new EpmError(409, 'CONFLICT', message);
  }

  /** The resource existed and no longer does — a used or expired invitation. */
  static gone(message: string) {
    return new EpmError(410, 'GONE', message);
  }

  static validation(message: string, details?: unknown) {
    return new EpmError(422, 'VALIDATION_FAILED', message, { details });
  }

  static timeout(message = 'The upstream request timed out.') {
    return new EpmError(504, 'TIMEOUT', message);
  }

  static unavailable(message = 'The upstream service is unavailable.', cause?: unknown) {
    return new EpmError(503, 'UPSTREAM_UNAVAILABLE', message, { cause });
  }

  static internal(message = 'Something went wrong on our end.', cause?: unknown) {
    return new EpmError(500, 'INTERNAL', message, { cause });
  }
}

/**
 * Raised by the OpenProject client. Kept distinct so route handlers can decide
 * whether an upstream 404 means "no such work package" (a real 404 for the
 * client) or an integration fault.
 */
export class OpenProjectError extends EpmError {
  readonly upstreamStatus: number;

  constructor(
    upstreamStatus: number,
    message: string,
    options: { upstream?: unknown; cause?: unknown } = {},
  ) {
    const { status, code } = mapUpstreamStatus(upstreamStatus);
    super(status, code, message, options);
    this.name = 'OpenProjectError';
    this.upstreamStatus = upstreamStatus;
  }

  /**
   * The `errorIdentifier` from the upstream body, e.g.
   * `urn:openproject-org:api:v3:errors:MissingPermission`.
   *
   * The status alone is too coarse to act on: 403 covers both "you may not read
   * this particular thing" and "you hold this permission nowhere", which call
   * for different answers.
   */
  get upstreamIdentifier(): string | undefined {
    const body = this.upstream as { errorIdentifier?: unknown } | undefined;
    return typeof body?.errorIdentifier === 'string' ? body.errorIdentifier : undefined;
  }
}

function mapUpstreamStatus(status: number): { status: number; code: ErrorCode } {
  // An upstream auth failure is a misconfiguration of *this* service, not of the
  // caller's session — surfacing it as 401 would bounce the user to login for a
  // problem they cannot fix.
  if (status === 401 || status === 403) {
    return { status: 502, code: 'UPSTREAM_ERROR' };
  }
  if (status === 404) return { status: 404, code: 'NOT_FOUND' };
  if (status === 409) return { status: 409, code: 'CONFLICT' };
  if (status === 422) return { status: 422, code: 'VALIDATION_FAILED' };
  if (status === 429) return { status: 503, code: 'UPSTREAM_UNAVAILABLE' };
  if (status === 0) return { status: 503, code: 'UPSTREAM_UNAVAILABLE' };
  return { status: 502, code: 'UPSTREAM_ERROR' };
}
