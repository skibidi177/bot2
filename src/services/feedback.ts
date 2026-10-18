import { AppError, NotFoundError, OrderStateError, PermissionDeniedError, RateLimitedError } from '../core/errors.js';
import type { AppContext } from './context.js';
import { BRAND_COLOR } from './delivery.js';
import type { EmbedData } from './notifier.js';
import { assertPerm } from './rbac.js';

const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 60_000;

/** Test hook: clears the per-user feedback cooldown map. */
export function resetFeedbackCooldowns(): void {
  cooldowns.clear();
}

function maskOrderCode(code: number): string {
  const s = String(code);
  return s.length <= 2 ? `#${s}` : `#${s.slice(0, 2)}${'*'.repeat(Math.min(4, s.length - 2))}`;
}

export function feedbackEmbed(opts: {
  code: number;
  rating: number;
  content: string;
  authorName: string;
  productName?: string;
}): EmbedData {
  return {
    title: `${'⭐'.repeat(opts.rating)}${'☆'.repeat(5 - opts.rating)} · Đơn ${maskOrderCode(opts.code)}`,
    description: opts.content || '(không có nội dung)',
    color: BRAND_COLOR,
    authorName: opts.authorName,
    footer: opts.productName ? `Sản phẩm: ${opts.productName}` : undefined,
    timestamp: new Date().toISOString(),
  };
}

/** Only the buyer of a COMPLETED order can review it, once per order. */
export async function submitFeedback(
  ctx: AppContext,
  input: { guildId: string; userId: string; userName: string; orderId: number; rating: number; content: string },
) {
  const last = cooldowns.get(input.userId) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) throw new RateLimitedError('Vui lòng chờ 1 phút giữa các lượt đánh giá');
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new AppError('bad_rating', 'Đánh giá phải từ 1 đến 5 sao');
  }
  const content = input.content.trim().slice(0, 1000);
  const order = await ctx.db.orders.get(input.orderId);
  if (!order || order.guildId !== input.guildId) throw new NotFoundError('Không tìm thấy đơn');
  if (order.buyerId !== input.userId) throw new PermissionDeniedError('Bạn chỉ đánh giá được đơn của chính mình');
  if (order.status !== 'COMPLETED') throw new OrderStateError('Chỉ đơn đã hoàn thành mới đánh giá được');
  if (await ctx.db.feedback.getByOrder(order.id)) throw new AppError('already_reviewed', 'Đơn này đã được đánh giá');

  const feedback = await ctx.db.feedback.create({
    orderId: order.id,
    guildId: input.guildId,
    authorId: input.userId,
    rating: input.rating,
    content,
  });
  cooldowns.set(input.userId, Date.now());

  const items = await ctx.db.orders.items(order.id);
  const settings = await ctx.db.guildConfig.get(input.guildId);
  if (settings.modules.feedbackChannelPost && settings.channels.feedback) {
    await ctx.notifier.sendChannel(settings.channels.feedback, {
      embeds: [
        feedbackEmbed({
          code: order.code,
          rating: input.rating,
          content,
          authorName: input.userName,
          productName: items.map((i) => i.productName).join(', '),
        }),
      ],
    });
  }
  await ctx.db.audit.log({
    guildId: input.guildId,
    actorType: 'user',
    actorId: input.userId,
    action: 'feedback.created',
    targetType: 'order',
    targetId: String(order.code),
    detail: { rating: input.rating },
  });
  return feedback;
}

export async function hideFeedback(
  ctx: AppContext,
  input: { guildId: string; actorId: string; feedbackId: number; reason: string },
) {
  await assertPerm(ctx, input.guildId, input.actorId, 'feedback.manage');
  const row = await ctx.db.feedback.update(input.feedbackId, { status: 'HIDDEN', hiddenReason: input.reason });
  if (row) {
    await ctx.db.audit.log({
      guildId: input.guildId,
      actorType: 'staff',
      actorId: input.actorId,
      action: 'feedback.hidden',
      targetType: 'feedback',
      targetId: String(input.feedbackId),
      detail: { reason: input.reason },
    });
  }
  return row;
}

export async function unhideFeedback(ctx: AppContext, input: { guildId: string; actorId: string; feedbackId: number }) {
  await assertPerm(ctx, input.guildId, input.actorId, 'feedback.manage');
  const row = await ctx.db.feedback.update(input.feedbackId, { status: 'VISIBLE', hiddenReason: null });
  if (row) {
    await ctx.db.audit.log({
      guildId: input.guildId,
      actorType: 'staff',
      actorId: input.actorId,
      action: 'feedback.unhidden',
      targetType: 'feedback',
      targetId: String(input.feedbackId),
    });
  }
  return row;
}

export async function replyFeedback(
  ctx: AppContext,
  input: { guildId: string; actorId: string; feedbackId: number; reply: string },
) {
  await assertPerm(ctx, input.guildId, input.actorId, 'feedback.manage');
  const row = await ctx.db.feedback.update(input.feedbackId, { shopReply: input.reply.slice(0, 1000) });
  if (row) {
    await ctx.db.audit.log({
      guildId: input.guildId,
      actorType: 'staff',
      actorId: input.actorId,
      action: 'feedback.replied',
      targetType: 'feedback',
      targetId: String(input.feedbackId),
    });
  }
  return row;
}

export async function shopStats(ctx: AppContext, guildId: string) {
  return ctx.db.feedback.stats(guildId);
}
