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
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (error) {
    app.log.fatal({ err: error }, 'Failed to start');
    process.exit(1);
  }
}

void main();
