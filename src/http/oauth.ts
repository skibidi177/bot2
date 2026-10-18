import { hmacSha256Hex, timingSafeEqualHex } from '../core/crypto.js';

export interface SessionPayload {
  uid: string;
  exp: number;
}

export class SessionManager {
  constructor(private readonly secret: string) {}

  sign(payload: SessionPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${hmacSha256Hex(this.secret, body)}`;
  }

  verify(cookie: string | undefined): SessionPayload | null {
    if (!cookie) return null;
    const [body, sig] = cookie.split('.');
    if (!body || !sig) return null;
    const expected = hmacSha256Hex(this.secret, body);
    if (!timingSafeEqualHex(expected, sig)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
      if (payload.exp * 1000 < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }
}

export function discordAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: 'identify',
    state: opts.state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ userId: string; username: string } | null> {
  const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  });
  if (!tokenRes.ok) return null;
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) return null;
  const userRes = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) return null;
  const user = (await userRes.json()) as { id: string; username: string };
  return { userId: user.id, username: user.username };
}
