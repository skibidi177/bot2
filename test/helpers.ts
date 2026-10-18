import { loadEnv, type Env } from '../src/config/env.js';
import { hmacSha256Hex } from '../src/core/crypto.js';
import { createLogger } from '../src/core/logger.js';
import { MemoryDb } from '../src/db/memory.js';
import { createContext, type AppContext } from '../src/services/context.js';
import { CaptureNotifier } from '../src/services/notifier.js';

export const TEST_SECRET = 'mock-webhook-secret-for-tests-0123456789';
export const SESSION_SECRET = 'session-secret-for-tests-0123456789abcdef';

export function testEnv(overrides: Partial<Env> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PAYMENT_PROVIDER: 'mock',
    MOCK_WEBHOOK_SECRET: TEST_SECRET,
    SESSION_SECRET,
    BANK_BIN: '970418',
    BANK_ACCOUNT_NUMBER: '8875505786',
    BANK_ACCOUNT_NAME: 'HOANG HUE QUYNH',
    BANK_DISPLAY_NAME: 'BIDV-CN NAM HA NOI PGD XA LA',
    APP_BASE_URL: 'http://localhost:8080',
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
}

export interface TestCtx {
  ctx: AppContext;
  db: MemoryDb;
  notifier: CaptureNotifier;
}

export function makeCtx(overrides: Partial<Env> = {}): TestCtx {
  const env = testEnv(overrides);
  const db = new MemoryDb();
  const notifier = new CaptureNotifier();
  const ctx = createContext({ env, logger: createLogger('fatal', 'test'), db, notifier });
  return { ctx, db, notifier };
}

export const GUILD = 'guild-1';
export const BUYER = 'user-buyer';
export const BUYER2 = 'user-buyer-2';
export const STAFF = 'user-staff';

export async function seedShop(t: TestCtx): Promise<{ categoryId: number; productId: number }> {
  const category = await t.ctx.db.categories.create({ slug: 'account', name: 'Account MMO' });
  const product = await t.ctx.db.products.create({
    sku: 'ACC-001',
    categoryId: category.id,
    name: 'Account MMO cao cấp',
    price: 50000,
    description: 'Account test',
  });
  return { categoryId: category.id, productId: product.id };
}

export async function addStock(t: TestCtx, productId: number, secrets: string[]): Promise<void> {
  await t.ctx.db.inventory.add(
    secrets.map((s) => ({ productId, ciphertext: t.ctx.cipher.encrypt(s) })),
  );
}

/** Sign a mock-provider webhook body the same way the staging tooling does. */
export function signMockWebhook(body: Record<string, unknown>): string {
  return hmacSha256Hex(TEST_SECRET, Buffer.from(JSON.stringify(body)));
}
