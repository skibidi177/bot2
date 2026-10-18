import { cidSafe } from '../core/ids.js';

export const COMPONENT_TTL_SECONDS = 15 * 60;

export interface ParsedCustomId {
  route: string;
  args: string[];
  exp: number | null;
}

/** Custom ids: v1:<route>:<arg>:<arg>:<expUnixSeconds> */
export function encodeCustomId(route: string, args: (string | number)[], ttlSeconds = COMPONENT_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return ['v1', route, ...args.map((a) => cidSafe(String(a))), String(exp)].join(':');
}

export function parseCustomId(customId: string): ParsedCustomId | null {
  const parts = customId.split(':');
  if (parts.length < 3 || parts[0] !== 'v1') return null;
  const route = parts[1]!;
  const exp = Number(parts[parts.length - 1]);
  if (!Number.isFinite(exp)) return null;
  return { route, args: parts.slice(2, -1), exp };
}

export function isExpired(parsed: ParsedCustomId): boolean {
  return parsed.exp !== null && parsed.exp * 1000 < Date.now();
}
