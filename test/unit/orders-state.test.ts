import { describe, expect, it } from 'vitest';
import { MemoryDb } from '../../src/db/memory.js';

describe('order state machine (conditional transitions)', () => {
  async function makeOrder(db: MemoryDb) {
    return db.orders.insert(
      {
        guildId: 'g',
        buyerId: 'u',
        subtotal: 1000,
        discount: 0,
        total: 1000,
        couponId: null,
        paymentTransferCode: 'M1',
        paymentProvider: 'mock',
        paymentExpiresAt: new Date(Date.now() + 60000),
      },
      [],
    );
  }

  it('applies a transition once and rejects repeats', async () => {
    const db = new MemoryDb();
    const order = await makeOrder(db);
    expect(await db.orders.transition(order.id, 'PENDING_PAYMENT', 'PAID', { actorType: 'provider' })).toBe(true);
    expect(await db.orders.transition(order.id, 'PENDING_PAYMENT', 'PAID', { actorType: 'provider' })).toBe(false);
    const fresh = await db.orders.get(order.id);
    expect(fresh?.status).toBe('PAID');
    expect(fresh?.paidAt).toBeTruthy();
  });

  it('rejects transitions from a wrong source state', async () => {
    const db = new MemoryDb();
    const order = await makeOrder(db);
    expect(await db.orders.transition(order.id, 'PAID', 'COMPLETED', { actorType: 'system' })).toBe(false);
  });

  it('records history for audit', async () => {
    const db = new MemoryDb();
    const order = await makeOrder(db);
    await db.orders.transition(order.id, 'PENDING_PAYMENT', 'EXPIRED', { actorType: 'system', reason: 'ttl' });
    const history = await db.orders.history(order.id);
    expect(history.map((h) => h.toStatus)).toEqual(['PENDING_PAYMENT', 'EXPIRED']);
  });

  it('rolls back the whole transaction when a step throws', async () => {
    const db = new MemoryDb();
    const order = await makeOrder(db);
    await expect(
      db.tx(async (tx) => {
        await tx.orders.transition(order.id, 'PENDING_PAYMENT', 'PAID', { actorType: 'provider' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const fresh = await db.orders.get(order.id);
    expect(fresh?.status).toBe('PENDING_PAYMENT');
  });
});
