import { buildApp } from './app.js';
import { env, describeEnv } from './config/env.js';

async function main() {
  const app = await buildApp();

  app.log.info(describeEnv(), 'Starting EPM backend');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info(`Received ${signal}, shutting down.`);
      void app.close().then(() => process.exit(0));
    });
  }

  try {
    /*
     * `::` binds dual-stack (IPv6 and IPv4-mapped), not IPv6-only.
     *
     * This matters more than it looks. Binding `0.0.0.0` serves IPv4 only, but
     * `localhost` resolves to `::1` first on Windows and modern macOS — so
     * every client connection was attempted against `::1`, refused, and only
     * then retried on `127.0.0.1`. Measured, that fallback cost ~306ms per
     * connection, which the browser then paid on each of the ~5 connections it
     * opens for a dashboard load.
     */
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (error) {
    app.log.fatal({ err: error }, 'Failed to start');
    process.exit(1);
  }
}

void main();
