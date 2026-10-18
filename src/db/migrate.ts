import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../core/logger.js';

/** Applies drizzle/migrations/*.sql to DATABASE_URL. Run: npm run db:migrate */
async function main() {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL, 'migrate');
  if (!env.DATABASE_URL) {
    logger.error('DATABASE_URL is required for migrations');
    process.exit(1);
  }
  const client = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  logger.info('Applying migrations…');
  await migrate(db, { migrationsFolder: new URL('../../drizzle/migrations', import.meta.url).pathname });
  logger.info('Migrations applied');
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
