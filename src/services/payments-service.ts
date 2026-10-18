import type { NormalizedPayment } from '../payments/types.js';
import type { AppContext } from './context.js';
import { fulfillOrder } from './delivery.js';
import { awardOrderCompletion } from './loyalty.js';
import { BRAND_COLOR } from './delivery.js';
import type { EmbedData } from './notifier.js';
import { formatVnd } from './pricing.js';

export interface IngestResult {
  ack: boolean;
  applied: boolean;
  reason?: string;
  orderCode?: number | null;
}

/** Notify the guild staff-alerts channel (falls back to logs channel). */
export async function notifyStaff(ctx: AppContext, guildId: string, embed: EmbedData): Promise<void> {
  const settings = await ctx.db.guildConfig.get(guildId);
  const channel = settings.channels.staffAlerts ?? settings.channels.logs;
  if (channel) await ctx.notifier.sendChannel(channel, { embeds: [embed] });
}

/**
 * Webhook entry point. Every payload is persisted as a payment_event first
 * (unique per provider+event id) so replays and duplicate deliveries are
 * impossible even when two webhooks arrive concurrently.
 */
export async function ingestWebhook(
  ctx: AppContext,
  providerName: string,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
): Promise<IngestResult> {
  const provider = ctx.providers[providerName];
  if (!provider) return { ack: false, applied: false, reason: 'unknown_provider' };
  const parsed = provider.parseWebhook(rawBody, headers);
  if (!parsed.ok) {
    await ctx.db.payments.insertEvent({
      provider: providerName,
      providerEventId: parsed.providerEventId,
      orderCode: null,
      payload: parsed.raw,
      signatureStatus: parsed.signatureStatus,
    });
    await ctx.db.audit.log({
      actorType: 'provider',
      actorId: providerName,
      action: 'payment.webhook_rejected',
      detail: { reason: parsed.reason, signatureStatus: parsed.signatureStatus },
    });
    return { ack: true, applied: false, reason: parsed.reason };
  }
  return applyPaymentEvent(ctx, providerName, parsed.payment, parsed.signatureStatus, 'provider_webhook', null);
}

/**
 * Apply a verified payment to its order. Safe to call multiple times:
 *  - payment_events unique(provider, providerEventId) blocks replayed webhooks
 *  - payment_transactions unique(provider, providerRef) blocks double settlement
 *  - orders.transition is conditional on the current status (row-level check)
 */
export async function applyPaymentEvent(
  ctx: AppContext,
  providerName: string,
  p: NormalizedPayment,
  signatureStatus: 'valid' | 'none',
  verifiedBy: 'provider_webhook' | 'staff',
  verifierId: string | null,
): Promise<IngestResult> {
  const event = await ctx.db.payments.insertEvent({
    provider: providerName,
    providerEventId: p.providerEventId,
    orderCode: p.orderCode,
    payload: p.raw,
    signatureStatus,
  });
  if (event.status === 'duplicate') {
    return { ack: true, applied: false, reason: 'duplicate_event', orderCode: p.orderCode };
  }

  if (p.status !== 'success') {
    await ctx.db.payments.markEventProcessed(event.row.id);
    await ctx.db.audit.log({
      actorType: 'provider',
      actorId: providerName,
      action: 'payment.failed',
      targetId: String(p.orderCode ?? ''),
      detail: { raw: p.raw },
    });
    return { ack: true, applied: false, reason: 'payment_failed', orderCode: p.orderCode };
  }

  const order = p.orderCode === null ? null : await ctx.db.orders.getByCode(p.orderCode);
  if (!order) {
    await ctx.db.payments.markEventProcessed(event.row.id);
    await ctx.db.audit.log({
      actorType: 'provider',
      actorId: providerName,
      action: 'payment.unknown_order',
      detail: { orderCode: p.orderCode, amount: p.amount },
    });
    return { ack: true, applied: false, reason: 'unknown_order', orderCode: p.orderCode };
  }

  // Amount reconciliation — never auto-fulfill a mismatched transfer.
  if (p.amount !== order.total) {
    await ctx.db.tx(async (db) => {
      await db.payments.createTransaction({
        orderId: order.id,
        provider: providerName,
        providerRef: p.providerRef,
        amount: p.amount,
        expectedAmount: order.total,
        status: 'amount_mismatch',
        verifiedBy,
        verifierId,
        counterAccount: p.counterAccount,
        counterAccountName: p.counterAccountName,
        paidAt: p.paidAt,
      });
      if (['PENDING_PAYMENT', 'MANUAL_REVIEW'].includes(order.status)) {
        await db.orders.transition(order.id, order.status, 'MANUAL_REVIEW', {
          actorType: verifiedBy === 'staff' ? 'staff' : 'provider',
          actorId: verifierId,
          reason: `amount mismatch: received ${p.amount}, expected ${order.total}`,
        });
      }
      await db.audit.log({
        guildId: order.guildId,
        actorType: verifiedBy === 'staff' ? 'staff' : 'provider',
        actorId: verifierId ?? providerName,
        action: 'payment.amount_mismatch',
        targetType: 'order',
        targetId: String(order.code),
        detail: { received: p.amount, expected: order.total, ref: p.providerRef },
      });
    });
    await notifyStaff(ctx, order.guildId, {
      title: '⚠️ Chuyển khoản sai số tiền',
      description: `Đơn #${order.code} nhận ${formatVnd(p.amount)} nhưng cần ${formatVnd(order.total)}. Đơn chuyển sang MANUAL_REVIEW, cần Finance xử lý.`,
      color: 0xd97706,
    });
    await ctx.db.payments.markEventProcessed(event.row.id);
    return { ack: true, applied: false, reason: 'amount_mismatch', orderCode: order.code };
  }

  const txStatus = await ctx.db.payments.createTransaction({
    orderId: order.id,
    provider: providerName,
    providerRef: p.providerRef,
    amount: p.amount,
    expectedAmount: order.total,
    status: 'success',
    verifiedBy,
    verifierId,
    counterAccount: p.counterAccount,
    counterAccountName: p.counterAccountName,
    paidAt: p.paidAt,
  });
  if (txStatus === 'duplicate') {
    await ctx.db.payments.markEventProcessed(event.row.id);
    return { ack: true, applied: false, reason: 'duplicate_transaction', orderCode: order.code };
  }

  let moved = false;
  if (order.status === 'PENDING_PAYMENT') {
    moved = await ctx.db.orders.transition(order.id, 'PENDING_PAYMENT', 'PAID', {
      actorType: verifiedBy === 'staff' ? 'staff' : 'provider',
      actorId: verifierId ?? providerName,
      reason: 'payment verified',
      paidAt: p.paidAt ?? new Date(),
    });
  } else if (order.status === 'MANUAL_REVIEW') {
    moved = await ctx.db.orders.transition(order.id, 'MANUAL_REVIEW', 'PAID', {
      actorType: verifiedBy === 'staff' ? 'staff' : 'provider',
      actorId: verifierId ?? providerName,
      reason: 'payment verified after review',
      paidAt: p.paidAt ?? new Date(),
    });
  } else if (['EXPIRED', 'CANCELLED'].includes(order.status)) {
    // money arrived for an order we already closed → hold for staff
    await ctx.db.orders.transition(order.id, order.status, 'MANUAL_REVIEW', {
      actorType: 'provider',
      actorId: providerName,
      reason: 'late payment after order closed',
    });
    await notifyStaff(ctx, order.guildId, {
      title: '⚠️ Thanh toán đến muộn',
      description: `Đơn #${order.code} đã ${order.status.toLowerCase()} nhưng vẫn nhận được ${formatVnd(p.amount)}. Cần Finance đối soát và hoàn tiền hoặc phục hồi đơn.`,
      color: 0xd97706,
    });
    await ctx.db.payments.markEventProcessed(event.row.id);
    await ctx.db.audit.log({
      guildId: order.guildId,
      actorType: 'provider',
      actorId: providerName,
      action: 'payment.late_duplicate',
      targetType: 'order',
      targetId: String(order.code),
      detail: { amount: p.amount },
    });
    return { ack: true, applied: false, reason: 'late_payment', orderCode: order.code };
  }

  if (!moved) {
    // concurrent webhook/confirmation lost the race: transaction row already exists, order untouched
    await ctx.db.payments.markEventProcessed(event.row.id);
    await ctx.db.audit.log({
      guildId: order.guildId,
      actorType: 'provider',
      actorId: providerName,
      action: 'payment.race_lost',
      targetType: 'order',
      targetId: String(order.code),
    });
    return { ack: true, applied: false, reason: 'state_conflict', orderCode: order.code };
  }

  const fresh = (await ctx.db.orders.get(order.id))!;
  const fulfillment = await fulfillOrder(ctx, fresh);
  if (fulfillment.completed) {
    const settings = await ctx.db.guildConfig.get(fresh.guildId);
    await awardOrderCompletion(ctx, fresh, settings);
  }
  if (!fulfillment.dmOk) {
    await notifyStaff(ctx, fresh.guildId, {
      title: '⚠️ Giao hàng tự động thất bại',
      description: `Không thể DM sản phẩm đơn #${fresh.code} (người mua khoá DM). Đơn ở trạng thái PROCESSING — dùng lệnh redeliver hoặc ticket.`,
      color: 0xd97706,
    });
  }
  if (fulfillment.mode === 'manual') {
    await notifyStaff(ctx, fresh.guildId, {
      title: '🧾 Đơn cần xử lý thủ công',
      description: `Đơn #${fresh.code} đã thanh toán ${formatVnd(fresh.total)} và chờ nhân viên xử lý.`,
      color: 0x2563eb,
    });
  }

  await ctx.db.payments.markEventProcessed(event.row.id);
  await ctx.db.audit.log({
    guildId: fresh.guildId,
    actorType: verifiedBy === 'staff' ? 'staff' : 'provider',
    actorId: verifierId ?? providerName,
    action: 'payment.confirmed',
    targetType: 'order',
    targetId: String(fresh.code),
    detail: { amount: p.amount, ref: p.providerRef, fulfillment: fulfillment.mode },
  });
  await ctx.notifier.sendDM(fresh.buyerId, {
    embeds: [
      {
        title: '✅ Thanh toán thành công',
        description:
          fulfillment.mode === 'auto' && fulfillment.dmOk
            ? `Đơn #${fresh.code} đã thanh toán. Sản phẩm đã được gửi trong DM riêng.`
            : `Đơn #${fresh.code} đã thanh toán và đang được xử lý. Nhân viên sẽ liên hệ nếu cần thêm thông tin.`,
        color: BRAND_COLOR,
        fields: [
          { name: 'Mã đơn', value: `#${fresh.code}`, inline: true },
          { name: 'Tổng tiền', value: formatVnd(fresh.total), inline: true },
        ],
      },
    ],
  });
  return { ack: true, applied: true, orderCode: fresh.code };
}
