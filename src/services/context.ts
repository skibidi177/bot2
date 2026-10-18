import type { Env } from '../config/env.js';
import { PlaintextCipher, SecretCipher, type Cipher } from '../core/crypto.js';
import type { Logger } from '../core/logger.js';
import type { Db } from '../db/repo.js';
import { ManualVietQrProvider, type BankConfig } from '../payments/manual.js';
import { MockProvider } from '../payments/mock.js';
import { PayOsProvider } from '../payments/payos.js';
import type { PaymentProvider } from '../payments/types.js';
import type { Notifier } from './notifier.js';

export interface AppContext {
  env: Env;
  logger: Logger;
  db: Db;
  cipher: Cipher;
  notifier: Notifier;
  providers: Record<string, PaymentProvider>;
  startedAt: Date;
}

export function bankConfigFromEnv(env: Env): BankConfig {
  return {
    bin: env.BANK_BIN ?? '970418',
    accountNumber: env.BANK_ACCOUNT_NUMBER ?? '0000000000',
    accountName: (env.BANK_ACCOUNT_NAME ?? 'MOCK ACCOUNT').toUpperCase(),
    displayName: env.BANK_DISPLAY_NAME,
  };
}

export function buildProviders(env: Env): Record<string, PaymentProvider> {
  const providers: Record<string, PaymentProvider> = {};
  if (env.PAYMENT_PROVIDER === 'payos') {
    providers.payos = new PayOsProvider({
      clientId: env.PAYOS_CLIENT_ID!,
      apiKey: env.PAYOS_API_KEY!,
      checksumKey: env.PAYOS_CHECKSUM_KEY!,
      returnUrl: `${env.APP_BASE_URL}/payment/return`,
      cancelUrl: `${env.APP_BASE_URL}/payment/cancel`,
    });
  } else if (env.PAYMENT_PROVIDER === 'manual') {
    providers.manual = new ManualVietQrProvider(bankConfigFromEnv(env));
  } else {
    if (!env.MOCK_WEBHOOK_SECRET) {
      throw new Error('PAYMENT_PROVIDER=mock requires MOCK_WEBHOOK_SECRET');
    }
    providers.mock = new MockProvider(env.MOCK_WEBHOOK_SECRET, bankConfigFromEnv(env));
  }
  return providers;
}

export function createCipher(env: Env, logger: Logger): Cipher {
  if (env.INVENTORY_ENC_KEY) return new SecretCipher(env.INVENTORY_ENC_KEY);
  if (env.NODE_ENV === 'production') {
    throw new Error('INVENTORY_ENC_KEY is required in production');
  }
  logger.warn('INVENTORY_ENC_KEY not set — inventory secrets stored with dev-only plaintext cipher');
  return new PlaintextCipher();
}

export function createContext(opts: {
  env: Env;
  logger: Logger;
  db: Db;
  notifier: Notifier;
  providers?: Record<string, PaymentProvider>;
}): AppContext {
  return {
    env: opts.env,
    logger: opts.logger,
    db: opts.db,
    cipher: createCipher(opts.env, opts.logger),
    notifier: opts.notifier,
    providers: opts.providers ?? buildProviders(opts.env),
    startedAt: new Date(),
  };
}

export function activeProvider(ctx: AppContext): PaymentProvider {
  const p = ctx.providers[ctx.env.PAYMENT_PROVIDER];
  if (!p) throw new Error(`Payment provider "${ctx.env.PAYMENT_PROVIDER}" is not configured`);
  return p;
}
