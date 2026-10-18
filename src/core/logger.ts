import pino from 'pino';

export function createLogger(level = 'info', name = 'bot2') {
  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST;
  return pino({
    level,
    base: { name },
    redact: {
      paths: [
        '*.token',
        '*.password',
        '*.secret',
        '*.apiKey',
        '*.api_key',
        '*.checksumKey',
        '*.checksum_key',
        '*.signature',
        '*.ciphertext',
        '*.secretCiphertext',
        '*.cookie',
        '*.authorization',
        'detail.secretCiphertext',
        'detail.secret',
      ],
      censor: '[redacted]',
    },
    transport:
      !isTest && process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
        : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
