import { z } from 'zod';

const boolStr = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  APP_BASE_URL: z.string().url().default('http://localhost:8080'),

  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_OAUTH_CLIENT_ID: z.string().optional(),
  DISCORD_OAUTH_CLIENT_SECRET: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  INVENTORY_ENC_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'INVENTORY_ENC_KEY must be 32 bytes of hex')
    .optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  BOOTSTRAP_OWNER_IDS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),

  PAYMENT_PROVIDER: z.enum(['payos', 'manual', 'mock']).default('manual'),
  PAYOS_CLIENT_ID: z.string().optional(),
  PAYOS_API_KEY: z.string().optional(),
  PAYOS_CHECKSUM_KEY: z.string().optional(),
  MOCK_WEBHOOK_SECRET: z.string().optional(),

  BANK_BIN: z
    .string()
    .regex(/^\d{6}$/, 'BANK_BIN must be a 6-digit bank BIN')
    .optional(),
  BANK_ACCOUNT_NUMBER: z
    .string()
    .regex(/^\d{6,20}$/, 'BANK_ACCOUNT_NUMBER must be 6-20 digits')
    .optional(),
  BANK_ACCOUNT_NAME: z.string().optional(),
  BANK_DISPLAY_NAME: z.string().optional(),
  ORDER_PAYMENT_TTL_MINUTES: z.coerce.number().int().min(1).max(720).default(15),

  ALLOW_MEMORY_DB: boolStr.default('false'),
  LOW_STOCK_CHECK_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(5),
  ORDER_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    const missing: string[] = [];
    if (!env.DISCORD_TOKEN) missing.push('DISCORD_TOKEN');
    if (!env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!env.INVENTORY_ENC_KEY) missing.push('INVENTORY_ENC_KEY');
    if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
    if (env.PAYMENT_PROVIDER === 'mock') {
      throw new Error('PAYMENT_PROVIDER=mock is forbidden in production');
    }
    if (env.PAYMENT_PROVIDER === 'payos') {
      for (const k of ['PAYOS_CLIENT_ID', 'PAYOS_API_KEY', 'PAYOS_CHECKSUM_KEY'] as const) {
        if (!env[k]) missing.push(k);
      }
    }
    if (env.PAYMENT_PROVIDER === 'manual' && !env.BANK_BIN) missing.push('BANK_BIN');
    if (missing.length) {
      throw new Error(`Production environment missing required variables: ${missing.join(', ')}`);
    }
  }
  if (env.PAYMENT_PROVIDER === 'payos' && env.NODE_ENV !== 'production') {
    for (const k of ['PAYOS_CLIENT_ID', 'PAYOS_API_KEY', 'PAYOS_CHECKSUM_KEY'] as const) {
      if (!env[k]) {
        throw new Error(`PAYMENT_PROVIDER=payos requires ${k}`);
      }
    }
  }
  if (env.PAYMENT_PROVIDER === 'manual' && !env.BANK_BIN) {
    // manual mode without bank config cannot render QR; fail fast in any env
    throw new Error('PAYMENT_PROVIDER=manual requires BANK_BIN, BANK_ACCOUNT_NUMBER, BANK_ACCOUNT_NAME');
  }
  return env;
}
