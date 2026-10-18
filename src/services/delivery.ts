import type { OrderRow } from '../db/types.js';
import type { AppContext } from './context.js';
import type { EmbedData } from './notifier.js';
import { formatVnd } from './pricing.js';

export const BRAND_COLOR = 0x04594c;

/** Collect decrypted secrets / delivery texts for an order and DM them to the buyer. */
export async function deliverSecrets(ctx: AppContext, order: OrderRow): Promise<boolean> {
  const items = await ctx.db.orders.items(order.id);
  const rows = await ctx.db.inventory.ciphertextsForOrder(order.id);
  const fields: { name: string; value: string }[] = [];
  for (const item of items) {
    const product = item.productId ? await ctx.db.products.get(item.productId) : null;
    const reserved = rows.filter((r) => r.productId === item.productId);
    if (reserved.length) {
      const secrets = reserved.slice(0, item.quantity).map((r) => `\`${ctx.cipher.decrypt(r.secretCiphertext)}\``);
      fields.push({ name: `${item.productName} ×${item.quantity}`, value: secrets.join('\n') });
    } else if (product?.deliveryMode === 'AUTO') {
      const meta = product.metadata as { deliveryText?: string };
      fields.push({
        name: `${item.productName} ×${item.quantity}`,
        value: meta.deliveryText?.trim() || 'Sản phẩm không có nội dung giao tự động, nhân viên sẽ gửi sau.',
      });
    }
  }
  if (!fields.length) return true; // nothing secret to deliver (manual products handled elsewhere)
  const embed: EmbedData = {
    title: `📦 Sản phẩm đơn #${order.code}`,
    description: `Cảm ơn bạn đã mua hàng! Thông tin dưới đây là **bảo mật**, không chia sẻ với bất kỳ ai.`,
    color: BRAND_COLOR,
    fields,
    footer: `Tổng thanh toán: ${formatVnd(order.total)}`,
  };
  return ctx.notifier.sendDM(order.buyerId, { embeds: [embed] });
}

export interface FulfillResult {
  mode: 'auto' | 'manual';
  dmOk: boolean;
  completed: boolean;
}

/**
 * Post-payment fulfillment. Auto products: mark inventory SOLD and DM secrets
 * exactly once; manual products: move to PROCESSING and alert staff.
 */
export async function fulfillOrder(ctx: AppContext, order: OrderRow): Promise<FulfillResult> {
  const items = await ctx.db.orders.items(order.id);
  let needsManual = false;
  let hasAutoSecrets = false;
  for (const item of items) {
    const product = item.productId ? await ctx.db.products.get(item.productId) : null;
    if (!product) continue;
    if (product.deliveryMode === 'MANUAL') needsManual = true;
    else hasAutoSecrets = true;
  }

  if (needsManual) {
    await ctx.db.orders.transition(order.id, 'PAID', 'PROCESSING', {
      actorType: 'system',
      reason: 'awaiting manual fulfillment',
    });
    return { mode: 'manual', dmOk: true, completed: false };
  }

  const dmOk = hasAutoSecrets ? await deliverSecrets(ctx, order) : true;
  if (!dmOk) {
    await ctx.db.orders.transition(order.id, 'PAID', 'PROCESSING', {
      actorType: 'system',
      reason: 'buyer DM closed — manual delivery required',
    });
    return { mode: 'auto', dmOk: false, completed: false };
  }

  const completed = await ctx.db.tx(async (db) => {
    await db.inventory.sellForOrder(order.id);
    return db.orders.transition(order.id, 'PAID', 'COMPLETED', {
      actorType: 'system',
      reason: 'auto delivery succeeded',
      completedAt: new Date(),
    });
  });
  return { mode: 'auto', dmOk: true, completed };
}
