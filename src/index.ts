import { loadEnv } from './config/env.js';
import { createLogger } from './core/logger.js';
import { connectDb } from './db/client.js';
import { createDiscordClient } from './discord/client.js';
import { DiscordNotifier } from './discord/notifier.js';
import { buildHttpApp } from './http/app.js';
import { startScheduler } from './jobs/scheduler.js';
import { createContext } from './services/context.js';
import { LateBoundNotifier, LoggingNotifier } from './services/notifier.js';

async function main() {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL, 'bot2');
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection (contained)');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });

  const dbHandle = await connectDb(env, logger);
  const notifier = new LateBoundNotifier();
  const ctx = createContext({ env, logger, db: dbHandle.db, notifier });

  const client = createDiscordClient(ctx);
  notifier.inner = client ? new DiscordNotifier(client) : new LoggingNotifier((msg, payload) => {
    logger.warn({ msg, content: payload.content }, 'notification dropped (no discord client)');
  });

  const http = await buildHttpApp(ctx);
  await http.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
  logger.info({ port: env.HTTP_PORT }, 'HTTP server listening (webhooks + admin)');

  if (client) await client.login(env.DISCORD_TOKEN);
  const scheduler = startScheduler(ctx);
  logger.info({ provider: env.PAYMENT_PROVIDER, db: dbHandle.db.kind }, 'bot2 started');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'graceful shutdown');
    scheduler.stop();
    await http.close().catch(() => undefined);
    await client?.destroy().catch(() => undefined);
    await dbHandle.close().catch(() => undefined);
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('fatal startup error:', err);
  process.exit(1);
});
