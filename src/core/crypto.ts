import crypto from 'node:crypto';

/** AES-256-GCM encryption for inventory secrets at rest. */
export class SecretCipher {
  private readonly key: Buffer;
  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) throw new Error('SecretCipher key must be 32 bytes');
  }
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
  }
  decrypt(payload: string): string {
    const [version, ivB64, tagB64, dataB64] = payload.split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('Malformed ciphertext');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64url'));
    d.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(dataB64, 'base64url')), d.final()]).toString('utf8');
  }
}

/** Fallback cipher for environments without a configured key (dev/test only). NOT for production. */
export class PlaintextCipher {
  encrypt(plaintext: string): string {
    return `v0.plain.${Buffer.from(plaintext, 'utf8').toString('base64url')}`;
  }
  decrypt(payload: string): string {
    if (!payload.startsWith('v0.plain.')) throw new Error('Malformed plaintext ciphertext');
    return Buffer.from(payload.slice('v0.plain.'.length), 'base64url').toString('utf8');
  }
}

export type Cipher = SecretCipher | PlaintextCipher;

export function hmacSha256Hex(key: string | Buffer, data: string | Buffer): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
