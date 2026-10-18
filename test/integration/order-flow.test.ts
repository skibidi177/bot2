import { describe, expect, it } from 'vitest';
import { OutOfStockError } from '../../src/core/errors.js';
import * as orders from '../../src/services/orders.js';
import { ingestWebhook } from '../../src/services/payments-service.js';
import { BUYER, GUILD, addStock, makeCtx, seedShop, signMockWebhook } from '../helpers.js';

function webhookBody(orderCode: number, amount: number, reference: string) {
  return JSON.stringify({ orderCode, amount, reference });
}

async function sendWebhook(t: ReturnType<typeof makeCtx>, orderCode: number, amount: number, reference: string) {
  const body = webhookBody(orderCode, amount, reference);
  return ingestWebhook(t.ctx, 'mock', Buffer.from(body), { 'x-mock-signature': signMockWebhook(JSON.parse(body)) });
}

describe('order → payment → delivery flow', () => {
  it('creates a pending order, reserves stock and renders a QR', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-1', 'KEY-2']);

    const created = await orders.createOrder(t.ctx, {
      guildId: GUILD,
      buyerId: BUYER,
      buyerName: 'buyer',
      lines: [{ productId, variantId: null, quantity: 1 }],
    });

    expect(created.order.status).toBe('PENDING_PAYMENT');
    expect(created.order.paymentTransferCode).toBe(`M${created.order.code}`);
    expect(created.draft.qrPng).toBeTruthy();
    expect(created.draft.qrString).toContain('M' + created.order.code);
    expect(await t.ctx.db.inventory.availableCount(productId)).toBe(1); // reserved
  });

  it('rejects buying more than available stock', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-1']);
    await expect(
      orders.createOrder(t.ctx, {
        guildId: GUILD,
        buyerId: BUYER,
        buyerName: 'buyer',
        lines: [{ productId, variantId: null, quantity: 2 }],
      }),
    ).rejects.toBeInstanceOf(OutOfStockError);
  });

  it('verifies a signed webhook, delivers secrets once and completes the order', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-1', 'KEY-2']);
    const created = await orders.createOrder(t.ctx, {
      guildId: GUILD,
      buyerId: BUYER,
      buyerName: 'buyer',
      lines: [{ productId, variantId: null, quantity: 1 }],
    });

    const res = await sendWebhook(t, created.order.code, created.order.total, 'TX-0001');
    expect(res.applied).toBe(true);

    const order = await t.ctx.db.orders.getByCode(created.order.code);
    expect(order?.status).toBe('COMPLETED');
    expect(await t.ctx.db.inventory.availableCount(productId)).toBe(1);

    const dm = t.notifier.dms.find((d) => d.userId === BUYER && d.payload.embeds?.some((e) => e.title?.includes('Sản phẩm đơn')));
    expect(dm).toBeTruthy();
    expect(JSON.stringify(dm?.payload)).toContain('KEY-1');

    // duplicate webhook must not deliver again
    const dup = await sendWebhook(t, created.order.code, created.order.total, 'TX-0001');
    expect(dup.applied).toBe(false);
    expect(dup.reason).toBe('duplicate_event');
    expect(t.notifier.dms.filter((d) => d.payload.embeds?.some((e) => e.title?.includes('Sản phẩm đơn'))).length).toBe(1);
  });

  it('routes wrong-amount payments to MANUAL_REVIEW without delivery', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-1']);
    const created = await orders.createOrder(t.ctx, {
      guildId: GUILD,
      buyerId: BUYER,
      buyerName: 'buyer',
      lines: [{ productId, variantId: null, quantity: 1 }],
    });

    const res = await sendWebhook(t, created.order.code, created.order.total - 5000, 'TX-BAD');
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('amount_mismatch');

    const order = await t.ctx.db.orders.getByCode(created.order.code);
    expect(order?.status).toBe('MANUAL_REVIEW');
    expect(t.notifier.dms.some((d) => d.payload.embeds?.some((e) => e.title?.includes('Sản phẩm đơn')))).toBe(false);
    const tx = await t.ctx.db.payments.getByOrder(created.order.id);
    expect(tx?.status).toBe('amount_mismatch');
  });

  it('rejects unsigned / badly signed webhooks', async () => {
    const t = makeCtx();
    const res = await ingestWebhook(t.ctx, 'mock', Buffer.from(JSON.stringify({ orderCode: 1, amount: 1, reference: 'X' })), {});
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('bad_signature');
  });

  it('cancelling a pending order releases reserved stock', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-1']);
    const created = await orders.createOrder(t.ctx, {
      guildId: GUILD,
      buyerId: BUYER,
      buyerName: 'buyer',
      lines: [{ productId, variantId: null, quantity: 1 }],
    });
    expect(await t.ctx.db.inventory.availableCount(productId)).toBe(0);
    const ok = await orders.cancelOrder(t.ctx, { orderId: created.order.id, actorId: BUYER, actorType: 'user' });
    expect(ok).toBe(true);
    expect(await t.ctx.db.inventory.availableCount(productId)).toBe(1);
  });

  it('expiry sweep expires pending orders and frees stock', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-1']);
    const created = await orders.createOrder(t.ctx, {
      guildId: GUILD,
      buyerId: BUYER,
      buyerName: 'buyer',
      lines: [{ productId, variantId: null, quantity: 1 }],
    });
    t.db._setOrderExpiry(created.order.code, new Date(Date.now() - 1000));
    const n = await orders.expireSweep(t.ctx);
    expect(n).toBe(1);
    const order = await t.ctx.db.orders.getByCode(created.order.code);
    expect(order?.status).toBe('EXPIRED');
    expect(await t.ctx.db.inventory.availableCount(productId)).toBe(1);
  });

  it('manual confirmation requires FINANCE permission and exact amount', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-1']);
    const created = await orders.createOrder(t.ctx, {
      guildId: GUILD,
      buyerId: BUYER,
      buyerName: 'buyer',
      lines: [{ productId, variantId: null, quantity: 1 }],
    });

    await expect(
      orders.confirmPaymentManual(t.ctx, { guildId: GUILD, actorId: 'random-user', orderCode: created.order.code, amount: created.order.total }),
    ).rejects.toThrow(/quyền/);

    await t.ctx.db.staff.grant(GUILD, 'finance-1', 'FINANCE', null);
    await expect(
      orders.confirmPaymentManual(t.ctx, { guildId: GUILD, actorId: 'finance-1', orderCode: created.order.code, amount: 1 }),
    ).rejects.toThrow(/khớp/);

    const res = await orders.confirmPaymentManual(t.ctx, {
      guildId: GUILD,
      actorId: 'finance-1',
      orderCode: created.order.code,
      amount: created.order.total,
      providerRef: 'BANK-REF-77',
    });
    expect(res.applied).toBe(true);
    const order = await t.ctx.db.orders.getByCode(created.order.code);
    expect(order?.status).toBe('COMPLETED');
    const audits = await t.ctx.db.audit.list({ action: 'payment.confirmed' });
    expect(audits.length).toBe(1);
    expect(audits[0]?.actorId).toBe('finance-1');
  });
});
