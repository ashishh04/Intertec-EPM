import { z } from 'zod';

/**
 * Validated process environment.
 *
 * The OpenProject credentials live here and nowhere else. Nothing in this module
 * is ever serialized into a response — `describeEnv()` exists so startup logging
 * can report configuration without leaking the API key.
 */

/**
 * `z.coerce.number()` runs before `.default()`, so an unset or empty variable
 * coerces to NaN/0 and fails validation instead of falling back. Normalising to
 * undefined first lets the default apply.
 */
const numberWithDefault = (fallback: number) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : value),
    z.coerce.number().int().positive().default(fallback),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: numberWithDefault(8000),
  API_PREFIX: z.string().startsWith('/').default('/api'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .refine((origins) => origins.length > 0, 'At least one CORS origin is required.')
    .refine(
      (origins) => !origins.includes('*'),
      'A wildcard CORS origin cannot be used with credentialed requests.',
    ),

  OPENPROJECT_BASE_URL: z.string().url('OPENPROJECT_BASE_URL must be an absolute URL.'),
  OPENPROJECT_API_KEY: z.string().min(1, 'OPENPROJECT_API_KEY is required.'),
  OPENPROJECT_TIMEOUT_MS: numberWithDefault(20_000),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters.'),

  // Credentials for the OAuth client EPM uses to exchange a user's username and
  // password for their own token. Optional so an instance that has not been
  // configured yet still boots — sign-in reports it rather than the whole
  // service refusing to start.
  OPENPROJECT_OAUTH_CLIENT_ID: z.string().optional(),
  OPENPROJECT_OAUTH_CLIENT_SECRET: z.string().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required.'),

  // OpenProject user ids that hold EPM-owned administrative permissions, which
  // no upstream capability implies. Configuration rather than a check against a
  // name: nothing in the source identifies a user, and leaving it unset simply
  // means nobody holds them until a grant row is written.
  // Periodic analytics capture. Off by default: a scheduler that started
  // itself would write to the metric table during every test run and every
  // `npm run dev`, and the safe default for something whose job is writing
  // history is not to.
  EPM_ANALYTICS_SNAPSHOT_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === 'true'),

  // Floored at five minutes. A typo like 0 or -1 must fail startup rather than
  // produce a scheduler that captures continuously.
  EPM_ANALYTICS_SNAPSHOT_INTERVAL_MINUTES: z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : value),
    z.coerce
      .number()
      .int()
      .min(5, 'EPM_ANALYTICS_SNAPSHOT_INTERVAL_MINUTES must be at least 5.')
      .max(60 * 24 * 7, 'EPM_ANALYTICS_SNAPSHOT_INTERVAL_MINUTES cannot exceed a week.')
      .default(60 * 24),
  ),

  EPM_ADMIN_USER_IDS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // A variable exported in the shell takes precedence over .env — Node's
    // --env-file does not overwrite what is already set — so a correct .env can
    // still fail here. Worth saying, because the cause is invisible otherwise.
    const shadowed = parsed.error.issues
      .map((issue) => String(issue.path[0]))
      .filter((key) => process.env[key] !== undefined);

    throw new Error(
      `Invalid backend configuration.\n${problems}\n\n` +
        'Copy .env.example to .env and fill it in.' +
        (shadowed.length
          ? `\n\nNote: ${shadowed.join(', ')} ${
              shadowed.length === 1 ? 'is' : 'are'
            } already set in your shell environment, which overrides .env. ` +
            'Unset it there if .env is meant to win.'
          : ''),
    );
  }

  return parsed.data;
}

export const env = load();

export const isProduction = env.NODE_ENV === 'production';

/** Startup-safe view of the configuration. Never includes the API key. */
export function describeEnv() {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    apiPrefix: env.API_PREFIX,
    corsOrigin: env.CORS_ORIGIN,
    openProjectBaseUrl: env.OPENPROJECT_BASE_URL,
    openProjectApiKey: '[redacted]',
    signIn: env.OPENPROJECT_OAUTH_CLIENT_ID ? 'configured' : 'not configured',
    database: env.DATABASE_URL.replace(/:\/\/[^@]*@/, '://[redacted]@'),
    // Neither is a secret; both are useful when a snapshot is missing.
    analyticsSnapshot: env.EPM_ANALYTICS_SNAPSHOT_ENABLED
      ? `every ${env.EPM_ANALYTICS_SNAPSHOT_INTERVAL_MINUTES} minutes`
      : 'disabled',
  };
}
