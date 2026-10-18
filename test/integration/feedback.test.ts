import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import * as feedback from '../../src/services/feedback.js';
import { beforeEach } from 'vitest';
import * as orders from '../../src/services/orders.js';
import { BUYER, BUYER2, GUILD, addStock, makeCtx, seedShop, signMockWebhook } from '../helpers.js';
import { ingestWebhook } from '../../src/services/payments-service.js';

async function completedOrder(t: ReturnType<typeof makeCtx>) {
  const { productId } = await seedShop(t);
  await addStock(t, productId, ['KEY-1']);
  const created = await orders.createOrder(t.ctx, { guildId: GUILD, buyerId: BUYER, buyerName: 'buyer', lines: [{ productId, variantId: null, quantity: 1 }] });
  const body = JSON.stringify({ orderCode: created.order.code, amount: created.order.total, reference: 'TX-FB' });
  await ingestWebhook(t.ctx, 'mock', Buffer.from(body), { 'x-mock-signature': signMockWebhook(JSON.parse(body)) });
  return created.order;
}

describe('feedback integrity', () => {
  beforeEach(() => feedback.resetFeedbackCooldowns());
  it('rejects feedback for non-completed or foreign orders', async () => {
    const t = makeCtx();
    const { productId } = await seedShop(t);
    await addStock(t, productId, ['KEY-1']);
    const pending = await orders.createOrder(t.ctx, { guildId: GUILD, buyerId: BUYER, buyerName: 'buyer', lines: [{ productId, variantId: null, quantity: 1 }] });

    await expect(
      feedback.submitFeedback(t.ctx, { guildId: GUILD, userId: BUYER, userName: 'buyer', orderId: pending.order.id, rating: 5, content: 'x' }),
    ).rejects.toThrow(/hoàn thành/);

    const order = await completedOrder(t);
    await expect(
      feedback.submitFeedback(t.ctx, { guildId: GUILD, userId: BUYER2, userName: 'other', orderId: order.id, rating: 5, content: 'fake' }),
    ).rejects.toThrow(/chính mình/);
  });

  it('accepts one feedback per completed order and posts to the feedback channel', async () => {
    const t = makeCtx();
    const settings = await t.ctx.db.guildConfig.get(GUILD);
    settings.channels.feedback = 'chan-feedback';
    await t.ctx.db.guildConfig.set(GUILD, settings);

    const order = await completedOrder(t);
    const fb = await feedback.submitFeedback(t.ctx, { guildId: GUILD, userId: BUYER, userName: 'buyer', orderId: order.id, rating: 5, content: 'Tuyệt vời' });
    expect(fb.status).toBe('VISIBLE');
    expect(t.notifier.channels.some((c) => c.channelId === 'chan-feedback')).toBe(true);

    await expect(
      feedback.submitFeedback(t.ctx, { guildId: GUILD, userId: BUYER, userName: 'buyer', orderId: order.id, rating: 1, content: 'again' }),
    ).rejects.toBeInstanceOf(AppError);

    const stats = await feedback.shopStats(t.ctx, GUILD);
    expect(stats.count).toBe(1);
    expect(stats.average).toBe(5);
    expect(stats.completedOrders).toBe(1);
  });

  it('hidden feedback is excluded from stats', async () => {
    const t = makeCtx();
    const order = await completedOrder(t);
    const fb = await feedback.submitFeedback(t.ctx, { guildId: GUILD, userId: BUYER, userName: 'buyer', orderId: order.id, rating: 1, content: 'spam' });
    await t.ctx.db.staff.grant(GUILD, 'admin', 'ADMINISTRATOR', null);
    await feedback.hideFeedback(t.ctx, { guildId: GUILD, actorId: 'admin', feedbackId: fb.id, reason: 'vi phạm' });
    const stats = await feedback.shopStats(t.ctx, GUILD);
    expect(stats.count).toBe(0);
  });
});
