import { describe, expect, it } from 'vitest';
import { OutOfStockError } from '../../src/core/errors.js';
import * as orders from '../../src/services/orders.js';
import { BUYER, BUYER2, GUILD, addStock, makeCtx, seedShop } from '../helpers.js';

describe('inventory concurrency', () => {
  it('two simultaneous buyers cannot both take the last item', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['LAST-KEY']);

    const [a, b] = await Promise.allSettled([
      orders.createOrder(t.ctx, { guildId: GUILD, buyerId: BUYER, buyerName: 'b1', lines: [{ productId, variantId: null, quantity: 1 }] }),
      orders.createOrder(t.ctx, { guildId: GUILD, buyerId: BUYER2, buyerName: 'b2', lines: [{ productId, variantId: null, quantity: 1 }] }),
    ]);

    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const rejected = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(OutOfStockError);

    expect(await t.ctx.db.inventory.availableCount(productId)).toBe(0);
    const reserved = await t.ctx.db.inventory.list({ productId, status: 'RESERVED' });
    expect(reserved.length).toBe(1);
  });

  it('cancelled order returns its reservation to the pool for the next buyer', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-A']);
    const first = await orders.createOrder(t.ctx, { guildId: GUILD, buyerId: BUYER, buyerName: 'b1', lines: [{ productId, variantId: null, quantity: 1 }] });
    await orders.cancelOrder(t.ctx, { orderId: first.order.id, actorId: BUYER, actorType: 'user' });
    const second = await orders.createOrder(t.ctx, { guildId: GUILD, buyerId: BUYER2, buyerName: 'b2', lines: [{ productId, variantId: null, quantity: 1 }] });
    expect(second.order.status).toBe('PENDING_PAYMENT');
  });

  it('refund returns sold items to available stock', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-R']);
    const created = await orders.createOrder(t.ctx, { guildId: GUILD, buyerId: BUYER, buyerName: 'b1', lines: [{ productId, variantId: null, quantity: 1 }] });
    await t.ctx.db.staff.grant(GUILD, 'fin', 'FINANCE', null);
    await orders.confirmPaymentManual(t.ctx, { guildId: GUILD, actorId: 'fin', orderCode: created.order.code, amount: created.order.total });
    expect(await t.ctx.db.inventory.availableCount(productId)).toBe(0);

    await orders.markRefund(t.ctx, { guildId: GUILD, actorId: 'fin', orderCode: created.order.code, stage: 'pending', reason: 'khach doi' });
    await orders.markRefund(t.ctx, { guildId: GUILD, actorId: 'fin', orderCode: created.order.code, stage: 'done', reason: 'da hoan tien' });
    const order = await t.ctx.db.orders.getByCode(created.order.code);
    expect(order?.status).toBe('REFUNDED');
    expect(await t.ctx.db.inventory.availableCount(productId)).toBe(1);
  });
});
