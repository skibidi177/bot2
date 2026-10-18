import { AppError, CouponError, NotFoundError, OrderStateError } from '../core/errors.js';
import { transferCode } from '../core/ids.js';
import type { OrderItemRow, OrderRow } from '../db/types.js';
import { vietQrPng } from '../payments/vietqr.js';
import type { PaymentDraft, NormalizedPayment } from '../payments/types.js';
import type { AppContext } from './context.js';
import { deliverSecrets, fulfillOrder } from './delivery.js';
import { awardOrderCompletion } from './loyalty.js';
import { discountFor, subtotalOf, validateCoupon, type CartLine } from './pricing.js';
import { assertPerm } from './rbac.js';
import { applyPaymentEvent } from './payments-service.js';

export interface CreateOrderInput {
  guildId: string;
  buyerId: string;
  buyerName: string;
  buyerGlobalName?: string | null;
  lines: { productId: number; variantId: number | null; quantity: number }[];
  couponCode?: string | null;
}

export interface CreatedOrder {
  order: OrderRow;
  items: OrderItemRow[];
  draft: PaymentDraft;
}

export async function createOrder(ctx: AppContext, input: CreateOrderInput): Promise<CreatedOrder> {
  const settings = await ctx.db.guildConfig.get(input.guildId);
  if (!input.lines.length) throw new AppError('empty_cart', 'Giỏ hàng trống');
  const maxQty = settings.payment.maxQuantityPerOrder;
  const totalQty = input.lines.reduce((s, l) => s + l.quantity, 0);
  if (totalQty > maxQty) throw new AppError('too_many_items', `Tối đa ${maxQty} sản phẩm mỗi đơn`);

  const cart: CartLine[] = [];
  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > maxQty) {
      throw new AppError('bad_quantity', 'Số lượng không hợp lệ');
    }
    const product = await ctx.db.products.get(line.productId);
    if (!product || !product.active) throw new NotFoundError('Sản phẩm không tồn tại hoặc đã ngừng bán');
    let unitPrice = product.price;
    let name = product.name;
    if (line.variantId !== null) {
      const variants = await ctx.db.products.variants(product.id);
      const variant = variants.find((v) => v.id === line.variantId && v.active);
      if (!variant) throw new NotFoundError('Biến thể sản phẩm không tồn tại');
      unitPrice += variant.priceDelta;
      name = `${product.name} · ${variant.name}`;
    }
    cart.push({ productId: product.id, variantId: line.variantId, name, unitPrice, quantity: line.quantity });
  }

  const subtotal = subtotalOf(cart);
  let coupon = null;
  if (input.couponCode?.trim()) {
    coupon = await ctx.db.coupons.get(input.couponCode.trim());
    if (!coupon) throw new CouponError('Mã giảm giá không tồn tại');
    validateCoupon(coupon, {
      subtotal,
      now: new Date(),
      totalUses: await ctx.db.coupons.uses(coupon.id),
      userUses: await ctx.db.coupons.userUses(coupon.id, input.buyerId),
    });
  }
  const discount = coupon ? discountFor(coupon, subtotal) : 0;
  const total = subtotal - discount;
  if (total <= 0) throw new CouponError('Mã giảm giá vượt quá giá trị đơn hàng');

  const order = await ctx.db.tx(async (db) => {
    await db.users.upsert({ id: input.buyerId, username: input.buyerName, globalName: input.buyerGlobalName ?? null });
    const inserted = await db.orders.insert(
      {
        guildId: input.guildId,
        buyerId: input.buyerId,
        subtotal,
        discount,
        total,
        couponId: coupon?.id ?? null,
        paymentTransferCode: 'PENDING', // replaced below once the sequence code is known
        paymentProvider: ctx.env.PAYMENT_PROVIDER,
        paymentExpiresAt: new Date(Date.now() + ctx.env.ORDER_PAYMENT_TTL_MINUTES * 60_000),
      },
      cart.map((l) => ({
        productId: l.productId,
        variantId: l.variantId,
        productName: l.name,
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        lineTotal: l.unitPrice * l.quantity,
      })),
    );
    // reserve stock inside the same transaction: two buyers can never take the last item
    const grouped = new Map<string, CartLine>();
    for (const l of cart) grouped.set(`${l.productId}:${l.variantId ?? ''}`, l);
    for (const l of grouped.values()) {
      const product = await db.products.get(l.productId);
      if (product?.stockTracked) {
        await db.inventory.reserve(l.productId, l.variantId, l.quantity, inserted.id);
      }
    }
    if (coupon) {
      const res = await db.coupons.redeem(coupon.id, inserted.id, input.buyerId);
      if (res !== 'ok') throw new CouponError(res === 'limit_user' ? 'Bạn đã dùng mã giảm giá này rồi' : 'Mã giảm giá đã hết lượt dùng');
    }
    const code = transferCode(inserted.code);
    await db.orders.setPaymentDetails(inserted.id, { paymentTransferCode: code });
    return { ...inserted, paymentTransferCode: code };
  });

  const provider = ctx.providers[ctx.env.PAYMENT_PROVIDER];
  if (!provider) throw new AppError('provider_missing', 'Payment provider chưa được cấu hình');
  const draft = await provider.createPayment(order, order.paymentTransferCode);
  if (draft.qrString && !draft.qrPng) draft.qrPng = await vietQrPng(draft.qrString);
  if (draft.providerRef) await ctx.db.orders.setPaymentDetails(order.id, { paymentRef: draft.providerRef });

  await ctx.db.audit.log({
    guildId: input.guildId,
    actorType: 'user',
    actorId: input.buyerId,
    action: 'order.created',
    targetType: 'order',
    targetId: String(order.code),
    detail: { total, items: cart.length, coupon: coupon?.code ?? null },
  });
  const items = await ctx.db.orders.items(order.id);
  return { order, items, draft };
}

export async function cancelOrder(
  ctx: AppContext,
  input: { orderId: number; actorId: string; actorType: 'user' | 'staff'; reason?: string },
): Promise<boolean> {
  return ctx.db.tx(async (db) => {
    const order = await db.orders.get(input.orderId);
    if (!order) throw new NotFoundError('Không tìm thấy đơn');
    if (input.actorType === 'user' && order.buyerId !== input.actorId) throw new NotFoundError('Không tìm thấy đơn');
    const cancellable: OrderRow['status'][] =
      input.actorType === 'user' ? ['PENDING_PAYMENT'] : ['PENDING_PAYMENT', 'MANUAL_REVIEW'];
    if (!cancellable.includes(order.status)) {
      throw new OrderStateError(`Đơn đang ở trạng thái ${order.status}, không thể huỷ`);
    }
    const ok = await db.orders.transition(order.id, order.status, 'CANCELLED', {
      actorType: input.actorType === 'user' ? 'user' : 'staff',
      actorId: input.actorId,
      reason: input.reason ?? 'cancelled',
      cancelReason: input.reason ?? (input.actorType === 'user' ? 'buyer cancelled' : 'staff cancelled'),
    });
    if (ok) await db.inventory.releaseForOrder(order.id);
    if (ok) {
      await db.audit.log({
        guildId: order.guildId,
        actorType: input.actorType === 'user' ? 'user' : 'staff',
        actorId: input.actorId,
        action: 'order.cancelled',
        targetType: 'order',
        targetId: String(order.code),
        detail: { reason: input.reason ?? null },
      });
    }
    return ok;
  });
}

/** Expire PENDING_PAYMENT orders past their payment window and release stock. */
export async function expireSweep(ctx: AppContext, limit = 50): Promise<number> {
  const expirable = await ctx.db.orders.expirable(new Date(), limit);
  let n = 0;
  for (const order of expirable) {
    const ok = await ctx.db.tx(async (db) => {
      const moved = await db.orders.transition(order.id, 'PENDING_PAYMENT', 'EXPIRED', {
        actorType: 'system',
        reason: 'payment window elapsed',
      });
      if (moved) await db.inventory.releaseForOrder(order.id);
      return moved;
    });
    if (ok) {
      n++;
      await ctx.db.audit.log({
        guildId: order.guildId,
        actorType: 'system',
        action: 'order.expired',
        targetType: 'order',
        targetId: String(order.code),
      });
      await ctx.notifier.sendDM(order.buyerId, {
        content: `⏰ Đơn #${order.code} đã hết hạn thanh toán và được giải phóng kho. Bạn có thể đặt lại bất cứ lúc nào.`,
      });
    }
  }
  return n;
}

/** Staff (FINANCE) confirms a bank transfer they verified out-of-band. Fully audit-logged. */
export async function confirmPaymentManual(
  ctx: AppContext,
  input: { guildId: string; actorId: string; orderCode: number; providerRef?: string; amount: number; note?: string },
) {
  await assertPerm(ctx, input.guildId, input.actorId, 'payments.confirm');
  const order = await ctx.db.orders.getByCode(input.orderCode);
  if (!order) throw new NotFoundError('Không tìm thấy đơn');
  if (!['PENDING_PAYMENT', 'MANUAL_REVIEW'].includes(order.status)) {
    throw new OrderStateError(`Đơn #${order.code} đang ở trạng thái ${order.status}`);
  }
  if (input.amount !== order.total) {
    throw new AppError('amount_mismatch', `Số tiền không khớp: đơn cần ${order.total}, nhập ${input.amount}`);
  }
  const providerRef = input.providerRef?.trim() || `manual-${order.code}`;
  const payment: NormalizedPayment = {
    providerEventId: `manual:${providerRef}`,
    providerRef,
    orderCode: order.code,
    amount: input.amount,
    status: 'success',
    counterAccount: null,
    counterAccountName: null,
    paidAt: new Date(),
    raw: { note: input.note ?? null, confirmedBy: input.actorId },
  };
  return applyPaymentEvent(ctx, 'manual', payment, 'none', 'staff', input.actorId);
}

export async function markRefund(
  ctx: AppContext,
  input: { guildId: string; actorId: string; orderCode: number; stage: 'pending' | 'done'; reason: string },
): Promise<boolean> {
  await assertPerm(ctx, input.guildId, input.actorId, 'payments.refund');
  return ctx.db.tx(async (db) => {
    const order = await db.orders.getByCode(input.orderCode);
    if (!order) throw new NotFoundError('Không tìm thấy đơn');
    if (input.stage === 'pending') {
      const from = ['PAID', 'PROCESSING', 'COMPLETED', 'MANUAL_REVIEW'].includes(order.status) ? order.status : null;
      if (!from) throw new OrderStateError(`Không thể hoàn tiền đơn trạng thái ${order.status}`);
      const ok = await db.orders.transition(order.id, from, 'REFUND_PENDING', {
        actorType: 'staff',
        actorId: input.actorId,
        reason: input.reason,
      });
      if (ok) {
        await db.audit.log({
          guildId: order.guildId,
          actorType: 'staff',
          actorId: input.actorId,
          action: 'order.refund_pending',
          targetType: 'order',
          targetId: String(order.code),
          detail: { reason: input.reason },
        });
      }
      return ok;
    }
    if (order.status !== 'REFUND_PENDING') throw new OrderStateError('Đơn chưa ở trạng thái REFUND_PENDING');
    const ok = await db.orders.transition(order.id, 'REFUND_PENDING', 'REFUNDED', {
      actorType: 'staff',
      actorId: input.actorId,
      reason: input.reason,
    });
    if (ok) {
      await db.inventory.restockForOrder(order.id);
      await db.audit.log({
        guildId: order.guildId,
        actorType: 'staff',
        actorId: input.actorId,
        action: 'order.refunded',
        targetType: 'order',
        targetId: String(order.code),
        detail: { reason: input.reason },
      });
    }
    return ok;
  });
}

/** Staff marks a manually-fulfilled order complete (delivery happened out-of-band). */
export async function completeManual(
  ctx: AppContext,
  input: { guildId: string; actorId: string; orderCode: number; reason?: string },
): Promise<boolean> {
  await assertPerm(ctx, input.guildId, input.actorId, 'orders.manage');
  const order = await ctx.db.orders.getByCode(input.orderCode);
  if (!order) throw new NotFoundError('Không tìm thấy đơn');
  const ok = await ctx.db.tx(async (db) => {
    const moved =
      (await db.orders.transition(order.id, 'PROCESSING', 'COMPLETED', {
        actorType: 'staff',
        actorId: input.actorId,
        reason: input.reason ?? 'manual fulfillment done',
        completedAt: new Date(),
      })) ||
      (await db.orders.transition(order.id, 'PAID', 'COMPLETED', {
        actorType: 'staff',
        actorId: input.actorId,
        reason: input.reason ?? 'manual fulfillment done',
        completedAt: new Date(),
      }));
    if (moved) {
      await db.inventory.sellForOrder(order.id);
      const settings = await db.guildConfig.get(order.guildId);
      await awardOrderCompletion(ctx, order, settings);
      await db.audit.log({
        guildId: order.guildId,
        actorType: 'staff',
        actorId: input.actorId,
        action: 'order.completed_manual',
        targetType: 'order',
        targetId: String(order.code),
      });
    }
    return moved;
  });
  return ok;
}

/** Staff re-sends delivered secrets (e.g. buyer DM was closed at first attempt). */
export async function redeliver(
  ctx: AppContext,
  input: { guildId: string; actorId: string; orderCode: number },
): Promise<boolean> {
  await assertPerm(ctx, input.guildId, input.actorId, 'orders.manage');
  const order = await ctx.db.orders.getByCode(input.orderCode);
  if (!order) throw new NotFoundError('Không tìm thấy đơn');
  const ok = await deliverSecrets(ctx, order);
  if (ok && order.status === 'PROCESSING') {
    await ctx.db.tx(async (db) => {
      await db.inventory.sellForOrder(order.id);
      return db.orders.transition(order.id, 'PROCESSING', 'COMPLETED', {
        actorType: 'staff',
        actorId: input.actorId,
        reason: 'redelivered after DM failure',
        completedAt: new Date(),
      });
    });
  }
  await ctx.db.audit.log({
    guildId: order.guildId,
    actorType: 'staff',
    actorId: input.actorId,
    action: 'order.redelivered',
    targetType: 'order',
    targetId: String(order.code),
    detail: { dmOk: ok },
  });
  return ok;
}

export async function orderSummary(ctx: AppContext, order: OrderRow) {
  const items = await ctx.db.orders.items(order.id);
  const history = await ctx.db.orders.history(order.id);
  const payment = await ctx.db.payments.getByOrder(order.id);
  return { items, history, payment };
}

export { fulfillOrder };
