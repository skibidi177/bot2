import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Env } from '../config/env.js';
import type { Logger } from '../core/logger.js';
import { DrizzleDb } from './drizzle.js';
import { MemoryDb } from './memory.js';
import type { Db } from './repo.js';
import * as schema from './schema.js';

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

export async function connectDb(env: Env, logger: Logger): Promise<DbHandle> {
  if (!env.DATABASE_URL) {
    const allowed = env.NODE_ENV === 'test' || env.ALLOW_MEMORY_DB;
    if (!allowed) {
      throw new Error(
        'DATABASE_URL is not set. Set it, or set ALLOW_MEMORY_DB=true for local demo (data lost on restart).',
      );
    }
    logger.warn('Using IN-MEMORY database — data is lost on restart. Never use in production.');
    const mem = new MemoryDb();
    return { db: mem, close: async () => undefined };
  }
  const client = postgres(env.DATABASE_URL, { max: 10, idle_timeout: 30, connect_timeout: 10 });
  const db = new DrizzleDb(drizzle(client, { schema }));
  return {
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
