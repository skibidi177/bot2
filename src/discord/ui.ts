import type { APIEmbed } from 'discord.js';
import type { EmbedData } from '../services/notifier.js';
import { formatVnd } from '../services/pricing.js';
import type { OrderItemRow, OrderRow } from '../db/types.js';

/** Convert the service-layer embed model into discord.js APIEmbed objects. */
export function emb(list: EmbedData[]): APIEmbed[] {
  return list.map((e) => ({
    title: e.title,
    description: e.description,
    color: e.color,
    fields: e.fields?.map((f) => ({ name: f.name, value: f.value, inline: f.inline })),
    footer: e.footer ? { text: e.footer } : undefined,
    image: e.imageUrl ? { url: e.imageUrl } : undefined,
    thumbnail: e.thumbnailUrl ? { url: e.thumbnailUrl } : undefined,
    url: e.url,
    timestamp: e.timestamp,
    author: e.authorName ? { name: e.authorName } : undefined,
  }));
}

export const BRAND = 0x04594c;
export const WARN = 0xd97706;
export const INFO = 0x2563eb;

export const STATUS_META: Record<OrderRow['status'], { label: string; emoji: string; color: number }> = {
  PENDING_PAYMENT: { label: 'Chờ thanh toán', emoji: '🕒', color: WARN },
  PAID: { label: 'Đã thanh toán', emoji: '💳', color: INFO },
  PROCESSING: { label: 'Đang xử lý', emoji: '🧾', color: INFO },
  COMPLETED: { label: 'Hoàn thành', emoji: '✅', color: BRAND },
  EXPIRED: { label: 'Hết hạn', emoji: '⏰', color: 0x6b7280 },
  CANCELLED: { label: 'Đã huỷ', emoji: '', color: 0x6b7280 },
  REFUND_PENDING: { label: 'Chờ hoàn tiền', emoji: '↩️', color: WARN },
  REFUNDED: { label: 'Đã hoàn tiền', emoji: '↩️', color: 0x6b7280 },
  MANUAL_REVIEW: { label: 'Cần kiểm tra', emoji: '⚠️', color: WARN },
};

export function orderEmbed(order: OrderRow, items: OrderItemRow[], opts: { history?: string[] } = {}): EmbedData {
  const meta = STATUS_META[order.status];
  const fields: EmbedData['fields'] = [
    { name: 'Trạng thái', value: `${meta.emoji} ${meta.label}`, inline: true },
    { name: 'Tổng tiền', value: formatVnd(order.total), inline: true },
    { name: 'Nội dung CK', value: `\`${order.paymentTransferCode}\``, inline: true },
  ];
  if (order.discount > 0) fields.push({ name: 'Giảm giá', value: `-${formatVnd(order.discount)}`, inline: true });
  if (order.status === 'PENDING_PAYMENT') {
    fields.push({
      name: 'Hạn thanh toán',
      value: `<t:${Math.floor(order.paymentExpiresAt.getTime() / 1000)}:R>`,
      inline: true,
    });
  }
  if (order.paidAt) fields.push({ name: 'Thanh toán lúc', value: `<t:${Math.floor(order.paidAt.getTime() / 1000)}:F>`, inline: true });
  return {
    title: `🧾 Đơn hàng #${order.code}`,
    description: items.map((i) => `• ${i.productName} ×${i.quantity} — ${formatVnd(i.lineTotal)}`).join('\n'),
    color: meta.color,
    fields,
    footer: opts.history?.length ? `Lịch sử: ${opts.history.join(' → ')}` : undefined,
    timestamp: order.createdAt.toISOString(),
  };
}

export function stars(rating: number): string {
  return '⭐'.repeat(Math.max(0, Math.min(5, rating))) + '☆'.repeat(5 - Math.max(0, Math.min(5, rating)));
}

export function timeLeft(order: OrderRow): string {
  const ms = order.paymentExpiresAt.getTime() - Date.now();
  if (ms <= 0) return 'đã hết hạn';
  const min = Math.floor(ms / 60000);
  return `${min} phút`;
}
