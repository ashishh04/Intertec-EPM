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
  // `::` is dual-stack. Override to `0.0.0.0` only where IPv6 is unavailable.
  HOST: z.string().default('::'),
  /*
   * Request ceiling per key per window. The default suits a single-tenant
   * deployment; raise it for a large workforce, or when many people share one
   * egress IP and the limiter cannot tell them apart.
   */
  RATE_LIMIT_MAX: numberWithDefault(600),
  RATE_LIMIT_WINDOW_MS: numberWithDefault(60_000),
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

  // Where the frontend lives, for links in email. Never derived from a request
  // header: a link that came from the Host header could be made to point
  // anywhere by whoever sent the request.
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),

  // --- Email --------------------------------------------------------------
  // Resend is the provider. With no key, email is logged rather than sent, so
  // development and tests exercise the whole path without a real delivery.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('EPM <epm@example.com>'),
  // SMTP, for a mailbox the organisation already owns. Takes precedence over
  // Resend when host, user and password are all set — see `email/index.ts`.
  // Chosen over Resend where no sending domain has been verified in DNS:
  // Resend will not deliver to anyone but its account owner until it has been,
  // and an ordinary mailbox has no such restriction.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: numberWithDefault(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  // Implicit TLS, as on port 465. Left unset, it follows the port, which is
  // the right answer for both 465 and 587.
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value === 'true')),
  // The outbox worker. Off by default for the same reason the snapshot
  // scheduler is: a process that sends mail should have to be asked to.
  EPM_EMAIL_WORKER_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  EPM_EMAIL_WORKER_INTERVAL_SECONDS: numberWithDefault(30),
  // Hour of the day, UTC, that the daily digest goes out.
  EPM_EMAIL_DIGEST_HOUR_UTC: z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : value),
    z.coerce.number().int().min(0).max(23).default(6),
  ),
  // Daily deadline reminder. Off by default, like every other scheduler here:
  // a process that emails a thousand people should have to be turned on.
  EPM_DUE_REMINDER_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  /*
   * The default hour a deadline reminder goes out, 0-23.
   *
   * Still named UTC because that is what it means for anybody whose timezone
   * EPM does not know: the sweep falls back to UTC then. For everyone else it is
   * read in their own zone, and each person can override it in Settings — so
   * this is the instance default rather than a global instant.
   */
  EPM_DUE_REMINDER_HOUR_UTC: z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : value),
    z.coerce.number().int().min(0).max(23).default(7),
  ),
  // How far ahead counts as "due soon". Beyond a fortnight a reminder stops
  // being a prompt and becomes noise.
  EPM_DUE_REMINDER_DAYS: z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : value),
    z.coerce.number().int().min(0).max(14).default(3),
  ),

  // Shared secret OpenProject signs webhook deliveries with.
  OPENPROJECT_WEBHOOK_SECRET: z.string().optional(),

  /*
   * The currency internal hourly rates are quoted in.
   *
   * Configuration rather than a read from upstream: OpenProject keeps
   * `costs_currency` in its costs module and publishes no API v3 resource for
   * it, so there is nothing to ask. An ISO 4217 code, because the frontend
   * formats it with `Intl.NumberFormat` and that is what it accepts.
   */
  EPM_CURRENCY: z
    .string()
    .default('AED')
    .refine((value) => /^[A-Za-z]{3}$/.test(value), 'EPM_CURRENCY must be a three-letter ISO 4217 code.')
    .transform((value) => value.toUpperCase()),

  // --- Assistant ------------------------------------------------------------
  // Claude in Amazon Bedrock. A region and a model are needed for Pragnya to
  // answer; with either missing the assistant reports itself unavailable
  // rather than failing on first use.
  //
  // The credentials below are not read by EPM. They are declared so that a
  // typo in .env fails validation here instead of surfacing as a 403 from AWS
  // an hour later; the SDK reads them from the environment itself, and falls
  // back to the shared profile, an assumed role or instance metadata when they
  // are absent — which is how a deployed task role works.
  AWS_REGION: z.string().optional(),
  // The SDK accepts AWS_DEFAULT_REGION too, as the AWS CLI does. Honoured
  // rather than silently ignored, which reads as "the region is wrong".
  AWS_DEFAULT_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
  // Carries the `anthropic.` provider prefix, e.g. anthropic.claude-sonnet-5.
  BEDROCK_MODEL_ID: z.string().optional(),

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
