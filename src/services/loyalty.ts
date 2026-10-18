import type { OrderRow } from '../db/types.js';
import type { AppContext } from './context.js';
import type { GuildSettings } from './guild-settings.js';

/** Award loyalty points + referral bonus for a completed order. Idempotent per order via ledger reason+order unique check. */
export async function awardOrderCompletion(ctx: AppContext, order: OrderRow, settings: GuildSettings): Promise<number> {
  if (!settings.modules.loyalty) return 0;
  const existing = await ctx.db.loyalty.entries(order.buyerId, 200);
  if (existing.some((e) => e.orderId === order.id && e.reason === 'order_completed')) return 0;

  const points = Math.floor(order.total / 1000) * settings.loyalty.pointsPer1000vnd;
  if (points > 0) {
    await ctx.db.loyalty.add(order.buyerId, points, 'order_completed', order.id);
  }

  const referral = await ctx.db.referrals.getByReferred(order.buyerId);
  if (referral && !referral.rewardedAt) {
    const referrerOrders = await ctx.db.orders.list({ buyerId: referral.referrerId, limit: 1, status: 'COMPLETED' });
    void referrerOrders;
    await ctx.db.loyalty.add(referral.referrerId, settings.loyalty.referralBonus, 'referral_bonus', order.id);
    await ctx.db.referrals.markRewarded(referral.id);
    await ctx.db.audit.log({
      guildId: order.guildId,
      actorType: 'system',
      action: 'loyalty.referral_rewarded',
      targetType: 'user',
      targetId: referral.referrerId,
      detail: { orderId: order.id, bonus: settings.loyalty.referralBonus },
    });
  }
  return points;
}
