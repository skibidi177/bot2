import { describe, expect, it } from 'vitest';
import * as feedback from '../../src/services/feedback.js';
import * as orders from '../../src/services/orders.js';
import { ingestWebhook } from '../../src/services/payments-service.js';
import { tierForPoints } from '../../src/services/guild-settings.js';
import { BUYER, GUILD, addStock, makeCtx, seedShop, signMockWebhook } from '../helpers.js';

describe('end-to-end purchase (test environment, mock provider)', () => {
  it('browse data → order → pay → deliver → feedback → loyalty', async () => {
    const t = makeCtx();

    // catalog
    const { categoryId, productId } = await seedShop(t);
    await addStock(t, productId, ['ACC|user1|pass1', 'ACC|user2|pass2']);
    const categories = await t.ctx.db.categories.list({ activeOnly: true });
    expect(categories.map((c) => c.id)).toContain(categoryId);
    const products = await t.ctx.db.products.list({ categoryId, activeOnly: true });
    expect(products.length).toBe(1);

    // order with coupon
    await t.ctx.db.coupons.create({ code: 'WELCOME10', kind: 'percent', value: 10, createdBy: 'system' });
    const created = await orders.createOrder(t.ctx, {
      guildId: GUILD,
      buyerId: BUYER,
      buyerName: 'buyer',
      lines: [{ productId, variantId: null, quantity: 1 }],
      couponCode: 'welcome10',
    });
    expect(created.order.subtotal).toBe(50000);
    expect(created.order.discount).toBe(5000);
    expect(created.order.total).toBe(45000);

    // pay via signed mock webhook
    const body = JSON.stringify({ orderCode: created.order.code, amount: created.order.total, reference: 'TX-E2E' });
    const res = await ingestWebhook(t.ctx, 'mock', Buffer.from(body), { 'x-mock-signature': signMockWebhook(JSON.parse(body)) });
    expect(res.applied).toBe(true);

    const order = await t.ctx.db.orders.getByCode(created.order.code);
    expect(order?.status).toBe('COMPLETED');

    // delivery DM carries the decrypted secret, never the ciphertext
    const dm = t.notifier.dms.find((d) => d.payload.embeds?.some((e) => e.title?.includes('Sản phẩm đơn')));
    expect(JSON.stringify(dm?.payload)).toContain('ACC|user1|pass1');
    expect(JSON.stringify(dm?.payload)).not.toContain('v1.');

    // loyalty ledger recorded
    const ledger = await t.ctx.db.loyalty.entries(BUYER);
    expect(ledger.some((l) => l.reason === 'order_completed' && l.orderId === order!.id)).toBe(true);
    const user = await t.ctx.db.users.get(BUYER);
    expect((user?.loyaltyPoints ?? 0) > 0).toBe(true);
    expect(tierForPoints(user?.loyaltyPoints ?? 0)).toBeTruthy();

    // feedback from the buyer of the completed order
    const fb = await feedback.submitFeedback(t.ctx, {
      guildId: GUILD,
      userId: BUYER,
      userName: 'buyer',
      orderId: order!.id,
      rating: 5,
      content: 'Nhanh, đúng mô tả',
    });
    expect(fb.rating).toBe(5);
    const stats = await feedback.shopStats(t.ctx, GUILD);
    expect(stats).toMatchObject({ count: 1, average: 5, completedOrders: 1 });

    // history trail exists for the buyer-facing order view
    const history = await t.ctx.db.orders.history(order!.id);
    expect(history.map((h) => h.toStatus)).toEqual(['PENDING_PAYMENT', 'PAID', 'COMPLETED']);
  });

  it('manual-delivery products stop at PROCESSING and alert staff', async () => {
    const t = makeCtx();
    const category = await t.ctx.db.categories.create({ slug: 'service', name: 'Dịch vụ' });
    const product = await t.ctx.db.products.create({
      sku: 'SVC-1',
      categoryId: category.id,
      name: 'Nạp thủ công',
      price: 20000,
      deliveryMode: 'MANUAL',
      stockTracked: false,
    });
    const settings = await t.ctx.db.guildConfig.get(GUILD);
    settings.channels.staffAlerts = 'chan-staff';
    await t.ctx.db.guildConfig.set(GUILD, settings);

    const created = await orders.createOrder(t.ctx, { guildId: GUILD, buyerId: BUYER, buyerName: 'b', lines: [{ productId: product.id, variantId: null, quantity: 1 }] });
    const body = JSON.stringify({ orderCode: created.order.code, amount: created.order.total, reference: 'TX-MAN' });
    await ingestWebhook(t.ctx, 'mock', Buffer.from(body), { 'x-mock-signature': signMockWebhook(JSON.parse(body)) });

    const order = await t.ctx.db.orders.getByCode(created.order.code);
    expect(order?.status).toBe('PROCESSING');
    expect(t.notifier.channels.some((c) => c.channelId === 'chan-staff')).toBe(true);

    // staff completes manually
    await t.ctx.db.staff.grant(GUILD, 'ops', 'FINANCE', null);
    const ok = await orders.completeManual(t.ctx, { guildId: GUILD, actorId: 'ops', orderCode: created.order.code });
    expect(ok).toBe(true);
    expect((await t.ctx.db.orders.getByCode(created.order.code))?.status).toBe('COMPLETED');
  });
});
