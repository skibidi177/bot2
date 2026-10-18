import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function randomCode(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Bank transfer content: short, unique, uppercase, no accents. e.g. M100042 */
export function transferCode(orderCode: number): string {
  return `M${orderCode}`;
}

export function ticketCode(): string {
  return `T${randomCode(6)}`;
}

export function referralCode(): string {
  return randomCode(8);
}

export function batchId(): string {
  return `B${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomCode(4)}`;
}

/** Sanitize a value so it can be embedded in a colon-separated custom id. */
export function cidSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}
