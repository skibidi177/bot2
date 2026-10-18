import { describe, expect, it } from 'vitest';
import { buildHttpApp } from '../../src/http/app.js';
import { SessionManager } from '../../src/http/oauth.js';
import * as orders from '../../src/services/orders.js';
import { BUYER, GUILD, SESSION_SECRET, addStock, makeCtx, seedShop, signMockWebhook, STAFF } from '../helpers.js';

async function app(t: ReturnType<typeof makeCtx>) {
  const http = await buildHttpApp(t.ctx);
  return http;
}

function sessionCookie(uid: string): string {
  const manager = new SessionManager(SESSION_SECRET);
  return `bot2_session=${manager.sign({ uid, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
}

describe('http surface', () => {
  it('healthz reports provider and db kind', async () => {
    const t = makeCtx();
    const http = await app(t);
    const res = await http.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: 'memory', provider: 'mock' });
    await http.close();
  });

  it('webhook endpoint ingests signed payment and rejects bad signatures', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-1']);
    const created = await orders.createOrder(t.ctx, { guildId: GUILD, buyerId: BUYER, buyerName: 'b', lines: [{ productId, variantId: null, quantity: 1 }] });

    const http = await app(t);
    const body = JSON.stringify({ orderCode: created.order.code, amount: created.order.total, reference: 'TX-HTTP' });
    const ok = await http.inject({
      method: 'POST',
      url: '/webhooks/payments/mock',
      headers: { 'content-type': 'application/json', 'x-mock-signature': signMockWebhook(JSON.parse(body)) },
      payload: body,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, applied: true });

    const bad = await http.inject({
      method: 'POST',
      url: '/webhooks/payments/mock',
      headers: { 'content-type': 'application/json', 'x-mock-signature': 'deadbeef' },
      payload: body,
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toMatchObject({ ok: true, applied: false, reason: 'bad_signature' });

    const unknown = await http.inject({ method: 'POST', url: '/webhooks/payments/nope', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(unknown.statusCode).toBe(404);
    await http.close();
  });

  it('admin API requires a session and enforces RBAC server-side', async () => {
    const t = makeCtx();
    await seedShop(t);
    const http = await app(t);

    const anon = await http.inject({ method: 'GET', url: `/api/admin/orders?guildId=${GUILD}` });
    expect(anon.statusCode).toBe(401);

    await t.ctx.db.staff.grant(GUILD, STAFF, 'SUPPORT', null);
    const support = await http.inject({
      method: 'GET',
      url: `/api/admin/products?guildId=${GUILD}`,
      headers: { cookie: sessionCookie(STAFF) },
    });
    expect(support.statusCode).toBe(403); // SUPPORT lacks products.manage

    await t.ctx.db.staff.grant(GUILD, STAFF, 'FINANCE', null);
    const finance = await http.inject({
      method: 'GET',
      url: `/api/admin/orders?guildId=${GUILD}`,
      headers: { cookie: sessionCookie(STAFF) },
    });
    expect(finance.statusCode).toBe(200);
    expect(Array.isArray(finance.json())).toBe(true);

    // FINANCE must not manage products
    const forbidden = await http.inject({
      method: 'POST',
      url: `/api/admin/products?guildId=${GUILD}`,
      headers: { cookie: sessionCookie(STAFF), 'content-type': 'application/json' },
      payload: JSON.stringify({ sku: 'X', name: 'X', price: 1 }),
    });
    expect(forbidden.statusCode).toBe(403);

    // tampered cookie is rejected
    const good = sessionCookie(STAFF);
    const tamperedCookie = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
    const tampered = await http.inject({
      method: 'GET',
      url: `/api/admin/orders?guildId=${GUILD}`,
      headers: { cookie: tamperedCookie },
    });
    expect(tampered.statusCode).toBe(401);
    await http.close();
  });

  it('admin confirm-payment endpoint works for FINANCE and is audit logged', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-1']);
    const created = await orders.createOrder(t.ctx, { guildId: GUILD, buyerId: BUYER, buyerName: 'b', lines: [{ productId, variantId: null, quantity: 1 }] });
    await t.ctx.db.staff.grant(GUILD, STAFF, 'FINANCE', null);
    const http = await app(t);
    const res = await http.inject({
      method: 'POST',
      url: `/api/admin/orders/${created.order.code}/confirm?guildId=${GUILD}`,
      headers: { cookie: sessionCookie(STAFF), 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: created.order.total, ref: 'BANK-1' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: true });
    const audits = await t.ctx.db.audit.list({ action: 'payment.confirmed' });
    expect(audits.length).toBe(1);
    await http.close();
  });

  it('cross-origin state-changing requests are blocked', async () => {
    const t = makeCtx();
    await t.ctx.db.staff.grant(GUILD, STAFF, 'OWNER', null);
    const http = await app(t);
    const res = await http.inject({
      method: 'POST',
      url: `/api/admin/orders/1/cancel?guildId=${GUILD}`,
      headers: { cookie: sessionCookie(STAFF), 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: JSON.stringify({ reason: 'x' }),
    });
    expect(res.statusCode).toBe(403);
    await http.close();
  });
});
