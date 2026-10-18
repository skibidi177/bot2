import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type TextChannel,
  type InteractionReplyOptions,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { AppError, PermissionDeniedError } from '../core/errors.js';
import type { ProductRow } from '../db/types.js';
import * as feedbackSvc from '../services/feedback.js';
import * as ordersSvc from '../services/orders.js';
import { createTicket, closeTicket } from '../services/tickets.js';
import { formatVnd } from '../services/pricing.js';
import { resolveStaff, roleCan } from '../services/rbac.js';
import type { AppContext } from '../services/context.js';
import type { CreatedOrder } from '../services/orders.js';
import { encodeCustomId, isExpired, parseCustomId } from './components.js';
import { EPHEMERAL, replyError } from './commands.js';
import { BRAND, emb, orderEmbed, STATUS_META, timeLeft, WARN } from './ui.js';

/** replyError wrapper: component/modal interactions are repliable at runtime but sit outside the TS union. */
function rerr(i: MessageComponentInteraction | ModalSubmitInteraction, err: unknown): Promise<void> {
  return replyError(i as unknown as Parameters<typeof replyError>[0], err);
}

async function expiredReply(i: MessageComponentInteraction | ModalSubmitInteraction): Promise<void> {
  const payload: InteractionReplyOptions = { content: ' Phiên tương tác đã hết hạn. Vui lòng thực hiện lại lệnh.', flags: EPHEMERAL };
  await i.reply(payload).catch(() => undefined);
}

function productDetailEmbed(product: ProductRow, stock: number | null): ReturnType<typeof orderEmbed> {
  return {
    title: `🛍️ ${product.name}`,
    description: product.description.slice(0, 1500) || '(không có mô tả)',
    color: BRAND,
    fields: [
      { name: 'Giá', value: formatVnd(product.price), inline: true },
      { name: 'Tồn kho', value: stock === null ? 'Không giới hạn' : String(stock), inline: true },
      { name: 'Giao hàng', value: product.deliveryMode === 'AUTO' ? 'Tự động qua DM' : 'Thủ công bởi nhân viên', inline: true },
    ],
    footer: product.imageUrl ? undefined : 'Ảnh sản phẩm xem tại dashboard',
    imageUrl: product.imageUrl ?? undefined,
  };
}

async function categoryView(ctx: AppContext, i: MessageComponentInteraction, categoryId: number): Promise<void> {
  const products = await ctx.db.products.list({ categoryId, activeOnly: true, limit: 25 });
  if (!products.length) {
    await i.update({ content: 'Danh mục tạm hết sản phẩm.', components: [], embeds: emb([]) }).catch(() => undefined);
    return;
  }
  const counts = await ctx.db.inventory.countsByProduct(products.map((p) => p.id));
  const select = new StringSelectMenuBuilder()
    .setCustomId(encodeCustomId('shop:prods', [categoryId]))
    .setPlaceholder('Chọn sản phẩm…')
    .addOptions(
      products.map((p) => ({
        label: `${p.name.slice(0, 90)}`,
        value: String(p.id),
        description: `${formatVnd(p.price)} · kho ${p.stockTracked ? (counts.get(p.id) ?? 0) : '∞'}`,
      })),
    );
  await i.update({
    content: null,
    embeds: emb([{ title: '🛒 Sản phẩm', description: 'Chọn sản phẩm để xem chi tiết.', color: BRAND }]),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  });
}

async function paymentMessage(ctx: AppContext, created: CreatedOrder): Promise<InteractionReplyOptions> {
  const { order, draft } = created;
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(encodeCustomId('ord:check', [order.code])).setLabel('🔎 Kiểm tra thanh toán').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(encodeCustomId('ord:cancel', [order.code])).setLabel('✖️ Huỷ đơn').setStyle(ButtonStyle.Danger),
  );
  const rows = [buttons];
  if (draft.checkoutUrl) {
    rows.unshift(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setURL(draft.checkoutUrl).setLabel('💳 Mở link thanh toán').setStyle(ButtonStyle.Link)));
  }
  return {
    embeds: emb([
      {
        title: `🧾 Đơn #${order.code} — chờ thanh toán`,
        description: draft.instructions,
        color: WARN,
        fields: [
          { name: 'Tổng tiền', value: formatVnd(order.total), inline: true },
          { name: 'Nội dung CK', value: `\`${order.paymentTransferCode}\``, inline: true },
          { name: 'Hạn thanh toán', value: timeLeft(order), inline: true },
        ],
        footer: 'QR/links chỉ dùng để thanh toán. Hệ thống chỉ xác nhận khi đối soát giao dịch hợp lệ.',
      },
    ]),
    files: draft.qrPng ? [{ attachment: draft.qrPng, name: 'vietqr.png', description: 'VietQR payment code' }] : [],
    components: rows,
    flags: EPHEMERAL,
  };
}

export async function handleComponent(ctx: AppContext, i: MessageComponentInteraction): Promise<void> {
  const parsed = parseCustomId(i.customId);
  if (!parsed) {
    await rerr(i, new AppError('bad_component', 'Tương tác không hợp lệ'));
    return;
  }
  if (isExpired(parsed)) {
    await expiredReply(i);
    return;
  }
  const [a0] = parsed.args;

  switch (parsed.route) {
    case 'shop:cats': {
      await categoryView(ctx, i, Number((i as StringSelectMenuInteraction).values[0]));
      return;
    }
    case 'shop:prods': {
      const product = await ctx.db.products.get(Number((i as StringSelectMenuInteraction).values[0]));
      if (!product || !product.active) {
        await i.update({ content: '⚠️ Sản phẩm không còn khả dụng.', components: [], embeds: emb([]) }).catch(() => undefined);
        return;
      }
      const stock = product.stockTracked ? await ctx.db.inventory.availableCount(product.id) : null;
      if (stock === 0) {
        await i.update({ content: '⚠️ Sản phẩm tạm hết hàng.', components: [], embeds: emb([]) }).catch(() => undefined);
        return;
      }
      const buy = new ButtonBuilder().setCustomId(encodeCustomId('shop:buy', [product.id])).setLabel('🛒 Mua ngay').setStyle(ButtonStyle.Primary);
      const back = new ButtonBuilder().setCustomId(encodeCustomId('shop:back', [Number(a0)])).setLabel('← Danh mục').setStyle(ButtonStyle.Secondary);
      await i.update({
        content: null,
        embeds: emb([productDetailEmbed(product, stock)]),
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buy, back)],
      });
      return;
    }
    case 'shop:back': {
      const categories = await ctx.db.categories.list({ activeOnly: true });
      const select = new StringSelectMenuBuilder()
        .setCustomId(encodeCustomId('shop:cats', []))
        .setPlaceholder('Chọn danh mục…')
        .addOptions(categories.slice(0, 25).map((c) => ({ label: c.name.slice(0, 100), value: String(c.id) })));
      await i.update({
        content: null,
        embeds: emb([{ title: '🛒 Cửa hàng MMO', description: 'Chọn danh mục để xem sản phẩm.', color: BRAND }]),
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      });
      return;
    }
    case 'shop:buy': {
      const productId = Number(a0);
      const modal = new ModalBuilder().setCustomId(encodeCustomId('shop:qty', [productId])).setTitle('Xác nhận mua hàng');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('qty').setLabel('Số lượng').setStyle(TextInputStyle.Short).setValue('1').setRequired(true).setMaxLength(2),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('coupon').setLabel('Mã giảm giá (tuỳ chọn)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(32),
        ),
      );
      await i.showModal(modal);
      return;
    }
    case 'ord:check': {
      const order = await ctx.db.orders.getByCode(Number(a0));
      if (!order || order.buyerId !== i.user.id) {
        await rerr(i, new AppError('not_found', 'Không tìm thấy đơn'));
        return;
      }
      const items = await ctx.db.orders.items(order.id);
      const meta = STATUS_META[order.status];
      const note =
        order.status === 'PENDING_PAYMENT'
          ? ctx.providers[ctx.env.PAYMENT_PROVIDER]?.automated
            ? 'Trạng thái cập nhật tự động khi nhà cung cấp thanh toán xác nhận giao dịch.'
            : 'Thanh toán được nhân viên Finance đối soát và xác nhận. Nút này chỉ xem trạng thái, không tự đánh dấu đã trả.'
          : order.status === 'COMPLETED'
            ? 'Sản phẩm đã gửi qua DM. Kiểm tra mục tin nhắn riêng.'
            : 'Nhân viên đang xử lý đơn của bạn.';
      await i.reply({
        embeds: emb([{ ...orderEmbed(order, items), description: `${meta.emoji} ${meta.label}\n${note}` }]),
        flags: EPHEMERAL,
      });
      return;
    }
    case 'ord:cancel': {
      const order = await ctx.db.orders.getByCode(Number(a0));
      if (!order || order.buyerId !== i.user.id) {
        await rerr(i, new AppError('not_found', 'Không tìm thấy đơn'));
        return;
      }
      const ok = await ordersSvc.cancelOrder(ctx, { orderId: order.id, actorId: i.user.id, actorType: 'user', reason: 'buyer cancelled via button' });
      await i.reply({ content: ok ? `✅ Đã huỷ đơn #${order.code}` : '⚠️ Không thể huỷ đơn lúc này', flags: EPHEMERAL });
      return;
    }
    case 'fb:pick': {
      const orderId = Number((i as StringSelectMenuInteraction).values[0]);
      const modal = new ModalBuilder().setCustomId(encodeCustomId('fb:modal', [orderId])).setTitle('Đánh giá giao dịch');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('rating').setLabel('Số sao (1-5)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('content').setLabel('Nội dung đánh giá').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000),
        ),
      );
      await i.showModal(modal);
      return;
    }
    case 'ver:confirm': {
      const guildId = i.guildId;
      if (!guildId || !i.member) {
        await rerr(i, new AppError('guild_only', 'Xác minh chỉ dùng trong server'));
        return;
      }
      const settings = await ctx.db.guildConfig.get(guildId);
      if (!settings.modules.verification || !settings.roles.verified) {
        await rerr(i, new AppError('not_configured', 'Server chưa bật xác minh'));
        return;
      }
      const member = i.member as { roles: { add(id: string): Promise<unknown> } };
      await member.roles.add(settings.roles.verified);
      await i.reply({ content: '✅ Đã xác minh thành viên. Chào mừng bạn!', flags: EPHEMERAL });
      return;
    }
    case 'tkt:close': {
      const ticketId = Number(a0);
      const ticket = await ctx.db.tickets.getById(ticketId);
      if (!ticket) {
        await rerr(i, new AppError('not_found', 'Không tìm thấy ticket'));
        return;
      }
      const staff = i.guildId ? await resolveStaff(ctx, i.guildId, i.user.id) : null;
      const staffOk = staff ? roleCan(staff.role, 'tickets.manage') : false;
      if (!staffOk && ticket.openerId !== i.user.id) throw new PermissionDeniedError();
      await closeTicket(ctx, { guildId: ticket.guildId, actorId: i.user.id, ticketId });
      await i.reply({ content: `✅ Đã đóng ticket ${ticket.code}` });
      return;
    }
    default:
      await rerr(i, new AppError('bad_component', `Route không hỗ trợ: ${parsed.route}`));
  }
}

export async function handleModal(ctx: AppContext, i: ModalSubmitInteraction): Promise<void> {
  const parsed = parseCustomId(i.customId);
  if (!parsed) {
    await rerr(i, new AppError('bad_component', 'Tương tác không hợp lệ'));
    return;
  }
  if (isExpired(parsed)) {
    await expiredReply(i);
    return;
  }
  const [a0] = parsed.args;

  switch (parsed.route) {
    case 'shop:qty': {
      const qty = Number.parseInt(i.fields.getTextInputValue('qty'), 10);
      const coupon = i.fields.getTextInputValue('coupon') || null;
      const guildId = i.guildId ?? 'dm';
      try {
        const created = await ordersSvc.createOrder(ctx, {
          guildId,
          buyerId: i.user.id,
          buyerName: i.user.username,
          buyerGlobalName: i.user.globalName,
          lines: [{ productId: Number(a0), variantId: null, quantity: qty }],
          couponCode: coupon,
        });
        await i.reply(await paymentMessage(ctx, created));
      } catch (err) {
        await rerr(i, err);
      }
      return;
    }
    case 'fb:modal': {
      const rating = Number.parseInt(i.fields.getTextInputValue('rating'), 10);
      const content = i.fields.getTextInputValue('content') ?? '';
      try {
        const fb = await feedbackSvc.submitFeedback(ctx, {
          guildId: i.guildId ?? 'dm',
          userId: i.user.id,
          userName: i.user.globalName ?? i.user.username,
          orderId: Number(a0),
          rating,
          content,
        });
        const stats = await feedbackSvc.shopStats(ctx, i.guildId ?? 'dm');
        await i.reply({
          content: `✅ Cảm ơn đánh giá ${'⭐'.repeat(fb.rating)} của bạn! Shop hiện có ${stats.count} đánh giá hiển thị, điểm trung bình ${stats.average || '—'}.`,
          flags: EPHEMERAL,
        });
      } catch (err) {
        await rerr(i, err);
      }
      return;
    }
    case 'tkt:modal': {
      const subject = i.fields.getTextInputValue('subject');
      const detail = i.fields.getTextInputValue('detail');
      const guildId = i.guildId ?? 'dm';
      const ticket = await createTicket(ctx, { guildId, openerId: i.user.id, subject: `${subject}\n${detail}`.slice(0, 200) });
      let channelNote = 'Nhân viên sẽ trả lời trong ticket.';
      if (i.guild && i.channel && 'threads' in i.channel) {
        try {
          const thread = await (i.channel as TextChannel).threads.create({
            name: `ticket-${ticket.code}`,
            autoArchiveDuration: 1440,
            reason: `Ticket ${ticket.code}`,
            invitable: false,
          });
          const closeBtn = new ButtonBuilder().setCustomId(encodeCustomId('tkt:close', [ticket.id], 60 * 60 * 24 * 7)).setLabel('🔒 Đóng ticket').setStyle(ButtonStyle.Danger);
          await thread.send({
            content: `<@${i.user.id}>`,
            embeds: emb([{ title: `🎫 Ticket ${ticket.code}`, description: `${subject}\n${detail}`.slice(0, 3000), color: BRAND }]),
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(closeBtn)],
          });
          await ctx.db.tickets.update(ticket.id, { channelId: thread.id });
          channelNote = `Ticket: ${thread.toString() ?? thread.name}`;
        } catch {
          const settings = await ctx.db.guildConfig.get(guildId);
          if (settings.channels.staffAlerts) {
            await ctx.notifier.sendChannel(settings.channels.staffAlerts, {
              embeds: [{ title: `🎫 Ticket ${ticket.code}`, description: `${subject}\n${detail}`.slice(0, 3000), color: BRAND }],
            });
          }
          channelNote = `Không tạo được thread, ticket mã ${ticket.code} đã báo staff.`;
        }
      }
      await i.reply({ content: `✅ Đã tạo ticket \`${ticket.code}\`. ${channelNote}`, flags: EPHEMERAL });
      return;
    }
    default:
      await rerr(i, new AppError('bad_component', `Route không hỗ trợ: ${parsed.route}`));
  }
}
