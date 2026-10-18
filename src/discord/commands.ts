import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type GuildMember,
  type InteractionReplyOptions,
  type RepliableInteraction,
} from 'discord.js';
import { AppError } from '../core/errors.js';
import { referralCode } from '../core/ids.js';
import type { AppContext } from '../services/context.js';
import * as catalog from '../services/catalog.js';
import * as feedback from '../services/feedback.js';
import * as orders from '../services/orders.js';
import { formatVnd } from '../services/pricing.js';
import { assertPerm, canManageRole, resolveStaff, ROLE_RANK, type Perm } from '../services/rbac.js';
import { mergeGuildSettings } from '../services/guild-settings.js';
import { encodeCustomId } from './components.js';
import { BRAND, emb, INFO, orderEmbed, STATUS_META, WARN } from './ui.js';

/** Ephemeral flag constant keeps discord.js bitfield typing precise. */
export const EPHEMERAL = MessageFlags.Ephemeral;

export interface CommandModule {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  run(ctx: AppContext, i: ChatInputCommandInteraction): Promise<void>;
}

export async function replyError(i: RepliableInteraction, err: unknown): Promise<void> {
  const message =
    err instanceof AppError
      ? err.message
      : err instanceof Error
        ? `Lỗi hệ thống: ${err.message}`
        : 'Lỗi không xác định';
  const payload: InteractionReplyOptions = { content: `⚠️ ${message}`, flags: EPHEMERAL };
  if (i.replied || i.deferred) await i.followUp(payload).catch(() => undefined);
  else await i.reply(payload).catch(() => undefined);
}

function guildIdOf(i: ChatInputCommandInteraction): string {
  return i.guildId ?? 'dm';
}

/* ------------------------------------------------------------------ shop */

const shop: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Mở cửa hàng sản phẩm số')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  async run(ctx, i) {
    const categories = await ctx.db.categories.list({ activeOnly: true });
    if (!categories.length) {
      await i.reply({ content: ' Cửa hàng đang cập nhật danh mục, quay lại sau nhé!', flags: EPHEMERAL });
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(encodeCustomId('shop:cats', []))
      .setPlaceholder('Chọn danh mục…')
      .addOptions(
        categories.slice(0, 25).map((c) => ({ label: c.name.slice(0, 100), value: String(c.id), description: c.description?.slice(0, 100) })),
      );
    await i.reply({
      embeds: emb([
        {
          title: '🛒 Cửa hàng MMO',
          description: 'Chọn danh mục để xem sản phẩm. Giá hiển thị là giá cuối cùng, không phí ẩn.',
          color: BRAND,
        },
      ]),
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      flags: EPHEMERAL,
    });
  },
};

/* -------------------------------------------------------------- customer */

const donHang: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('don-hang')
    .setDescription('Tra cứu đơn hàng của bạn')
    .addIntegerOption((o) => o.setName('code').setDescription('Mã đơn hàng').setRequired(true))
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  async run(ctx, i) {
    const code = i.options.getInteger('code', true);
    const order = await ctx.db.orders.getByCode(code);
    if (!order || order.buyerId !== i.user.id) {
      await i.reply({ content: '⚠️ Không tìm thấy đơn hàng của bạn.', flags: EPHEMERAL });
      return;
    }
    const items = await ctx.db.orders.items(order.id);
    const history = (await ctx.db.orders.history(order.id)).map((h) => STATUS_META[h.toStatus].label);
    await i.reply({ embeds: emb([orderEmbed(order, items, { history })]), flags: EPHEMERAL });
  },
};

const lichSu: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('lich-su-mua')
    .setDescription('Lịch sử mua hàng của bạn')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  async run(ctx, i) {
    const list = await ctx.db.orders.list({ buyerId: i.user.id, limit: 10 });
    if (!list.length) {
      await i.reply({ content: 'Bạn chưa có đơn hàng nào.', flags: EPHEMERAL });
      return;
    }
    await i.reply({
      embeds: emb([
        {
          title: '📜 Lịch sử mua hàng',
          description: list
            .map((o) => `#${o.code} · ${STATUS_META[o.status].emoji} ${STATUS_META[o.status].label} · ${formatVnd(o.total)} · <t:${Math.floor(o.createdAt.getTime() / 1000)}:d>`)
            .join('\n'),
          color: BRAND,
        },
      ]),
      flags: EPHEMERAL,
    });
  },
};

const danhGia: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('danh-gia')
    .setDescription('Đánh giá đơn hàng đã hoàn thành')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  async run(ctx, i) {
    const completed = await ctx.db.orders.list({ buyerId: i.user.id, status: 'COMPLETED', limit: 25 });
    const options: { label: string; value: string }[] = [];
    for (const o of completed) {
      const existing = await ctx.db.feedback.getByOrder(o.id);
      if (existing) continue;
      const items = await ctx.db.orders.items(o.id);
      options.push({ label: `#${o.code} · ${items.map((x) => x.productName).join(', ').slice(0, 60)}`, value: String(o.id) });
    }
    if (!options.length) {
      await i.reply({ content: 'Bạn chưa có đơn hoàn thành nào cần đánh giá.', flags: EPHEMERAL });
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(encodeCustomId('fb:pick', []))
      .setPlaceholder('Chọn đơn muốn đánh giá…')
      .addOptions(options.slice(0, 25));
    await i.reply({
      content: '⭐ Mỗi đơn hoàn thành được đánh giá một lần bởi chính người mua.',
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      flags: EPHEMERAL,
    });
  },
};

const ticket: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Tạo ticket hỗ trợ')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  async run(_ctx, i) {
    const modal = new ModalBuilder().setCustomId(encodeCustomId('tkt:modal', [])).setTitle(' Ticket hỗ trợ');
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('subject').setLabel('Chủ đề').setStyle(TextInputStyle.Short).setMaxLength(150).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('detail').setLabel('Mô tả chi tiết').setStyle(TextInputStyle.Paragraph).setMaxLength(1500).setRequired(true),
      ),
    );
    await i.showModal(modal);
  },
};

const faq: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('faq')
    .setDescription('Câu hỏi thường gặp')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  async run(_ctx, i) {
    await i.reply({
      embeds: emb([
        {
          title: '❓ Câu hỏi thường gặp',
          color: INFO,
          fields: [
            { name: 'Mua hàng thế nào?', value: 'Gõ `/shop` → chọn danh mục → chọn sản phẩm → nhập số lượng → quét QR chuyển khoản.' },
            { name: 'Bao lâu nhận được hàng?', value: 'Sản phẩm tự động được gửi qua DM ngay khi thanh toán được xác minh. Sản phẩm thủ công sẽ có nhân viên xử lý.' },
            { name: 'Chuyển khoản sai nội dung?', value: 'Đơn sẽ chuyển sang trạng thái cần kiểm tra. Mở `/ticket` kèm mã đơn để được đối soát.' },
            { name: 'Đơn hết hạn?', value: 'Đơn chờ thanh toán quá hạn sẽ tự huỷ và giải phóng kho. Bạn chỉ cần đặt lại đơn mới.' },
            { name: 'DM bị khoá?', value: 'Bật DM trong Settings → Privacy. Nếu vẫn không nhận được hàng, mở `/ticket`, nhân viên sẽ gửi lại.' },
          ],
        },
      ]),
      flags: EPHEMERAL,
    });
  },
};

const help: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Hướng dẫn sử dụng bot')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  async run(_ctx, i) {
    await i.reply({
      embeds: emb([
        {
          title: '📘 Hướng dẫn',
          color: BRAND,
          description: [
            '`/shop` — duyệt và mua sản phẩm số',
            '`/don-hang <code>` — tra cứu đơn của bạn',
            '`/lich-su-mua` — lịch sử giao dịch',
            '`/danh-gia` — đánh giá đơn hoàn thành (1 lần/đơn)',
            '`/ticket` — hỗ trợ thủ công',
            '`/loi-moi [code]` — mã giới thiệu & điểm thưởng',
            '`/faq` — câu hỏi thường gặp',
          ].join('\n'),
          footer: 'Mọi thanh toán chỉ được xác nhận bởi hệ thống đối soát hoặc nhân viên Finance có thẩm quyền.',
        },
      ]),
      flags: EPHEMERAL,
    });
  },
};

const loiMoi: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('loi-moi')
    .setDescription('Mã giới thiệu của bạn / nhập mã của người giới thiệu')
    .addStringOption((o) => o.setName('code').setDescription('Mã của người giới thiệu bạn').setRequired(false))
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  async run(ctx, i) {
    const inputCode = i.options.getString('code');
    const me = await ctx.db.users.upsert({ id: i.user.id, username: i.user.username, globalName: i.user.globalName });
    if (inputCode) {
      const referrer = await ctx.db.users.getByReferralCode(inputCode.trim().toUpperCase());
      if (!referrer) {
        await replyError(i, new AppError('bad_ref', 'Mã giới thiệu không tồn tại'));
        return;
      }
      const res = await ctx.db.referrals.link(referrer.id, i.user.id);
      const msg =
        res === 'ok'
          ? '✅ Đã ghi nhận người giới thiệu. Thưởng sẽ cấp khi đơn đầu tiên của bạn hoàn thành.'
          : res === 'self'
            ? '⚠️ Không thể tự giới thiệu chính mình.'
            : '⚠️ Bạn đã có người giới thiệu trước đó.';
      await i.reply({ content: msg, flags: EPHEMERAL });
      return;
    }
    let code = me.referralCode;
    if (!code) {
      for (let attempt = 0; attempt < 5; attempt++) {
        code = referralCode();
        const clash = await ctx.db.users.getByReferralCode(code);
        if (!clash) break;
        code = null;
      }
      if (!code) throw new AppError('ref_gen', 'Không sinh được mã, thử lại sau');
      await ctx.db.users.setReferralCode(i.user.id, code);
    }
    const referred = await ctx.db.referrals.countByReferrer(i.user.id);
    await i.reply({
      embeds: emb([
        {
          title: '🤝 Chương trình giới thiệu',
          description: `Mã của bạn: \`${code}\`\nNgười khác dùng mã này khi lần đầu tham gia. Bạn nhận điểm thưởng khi đơn đầu tiên của họ hoàn thành.`,
          color: BRAND,
          fields: [{ name: 'Đã giới thiệu', value: String(referred), inline: true }],
          footer: 'Tự giới thiệu hoặc gian lận giới thiệu sẽ không được tính.',
        },
      ]),
      flags: EPHEMERAL,
    });
  },
};

/* ----------------------------------------------------------------- admin */

async function guard(ctx: AppContext, i: ChatInputCommandInteraction, perm: Perm): Promise<boolean> {
  try {
    await assertPerm(ctx, guildIdOf(i), i.user.id, perm);
    return true;
  } catch (err) {
    await replyError(i, err);
    return false;
  }
}

const admin: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Quản trị cửa hàng')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) =>
      s
        .setName('product-create')
        .setDescription('Tạo sản phẩm')
        .addStringOption((o) => o.setName('sku').setRequired(true))
        .addStringOption((o) => o.setName('name').setRequired(true))
        .addIntegerOption((o) => o.setName('price').setRequired(true).setDescription('Giá VND'))
        .addStringOption((o) => o.setName('category').setDescription('Slug danh mục'))
        .addStringOption((o) => o.setName('description'))
        .addStringOption((o) => o.setName('delivery').addChoices({ name: 'Tự động', value: 'AUTO' }, { name: 'Thủ công', value: 'MANUAL' }))
        .addBooleanOption((o) => o.setName('stock_tracked'))
        .addStringOption((o) => o.setName('image').setDescription('URL ảnh')),
    )
    .addSubcommand((s) =>
      s
        .setName('product-edit')
        .setDescription('Sửa sản phẩm')
        .addIntegerOption((o) => o.setName('product_id').setRequired(true))
        .addStringOption((o) => o.setName('name'))
        .addIntegerOption((o) => o.setName('price'))
        .addStringOption((o) => o.setName('description'))
        .addBooleanOption((o) => o.setName('active'))
        .addStringOption((o) => o.setName('image')),
    )
    .addSubcommand((s) =>
      s.setName('product-delete').setDescription('Xoá mềm sản phẩm').addIntegerOption((o) => o.setName('product_id').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('product-list').setDescription('Danh sách sản phẩm'))
    .addSubcommand((s) =>
      s
        .setName('category-add')
        .setDescription('Thêm danh mục')
        .addStringOption((o) => o.setName('slug').setRequired(true))
        .addStringOption((o) => o.setName('name').setRequired(true))
        .addStringOption((o) => o.setName('description')),
    )
    .addSubcommand((s) =>
      s
        .setName('inventory-add')
        .setDescription('Nhập kho (file csv cột secret hoặc văn bản nhiều dòng)')
        .addIntegerOption((o) => o.setName('product_id').setRequired(true))
        .addAttachmentOption((o) => o.setName('file').setDescription('CSV: cột secret hoặc sku,secret'))
        .addStringOption((o) => o.setName('lines').setDescription('Mỗi dòng một key/account')),
    )
    .addSubcommand((s) =>
      s
        .setName('order-view')
        .setDescription('Xem đơn')
        .addIntegerOption((o) => o.setName('code').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('order-confirm')
        .setDescription('Xác nhận thanh toán thủ công (Finance)')
        .addIntegerOption((o) => o.setName('code').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setRequired(true))
        .addStringOption((o) => o.setName('ref').setDescription('Mã GD ngân hàng'))
        .addStringOption((o) => o.setName('note')),
    )
    .addSubcommand((s) =>
      s
        .setName('order-refund')
        .setDescription('Hoàn tiền (2 bước)')
        .addIntegerOption((o) => o.setName('code').setRequired(true))
        .addStringOption((o) => o.setName('stage').addChoices({ name: 'pending', value: 'pending' }, { name: 'done', value: 'done' }).setRequired(true))
        .addStringOption((o) => o.setName('reason').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('order-complete').setDescription('Đánh dấu đơn thủ công hoàn thành').addIntegerOption((o) => o.setName('code').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('order-redeliver').setDescription('Gửi lại sản phẩm qua DM').addIntegerOption((o) => o.setName('code').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('coupon-create')
        .setDescription('Tạo mã giảm giá')
        .addStringOption((o) => o.setName('code').setRequired(true))
        .addStringOption((o) => o.setName('kind').addChoices({ name: 'percent', value: 'percent' }, { name: 'fixed', value: 'fixed' }).setRequired(true))
        .addIntegerOption((o) => o.setName('value').setRequired(true))
        .addIntegerOption((o) => o.setName('max_uses'))
        .addIntegerOption((o) => o.setName('min_order'))
        .addIntegerOption((o) => o.setName('expires_days')),
    )
    .addSubcommand((s) => s.setName('coupon-list').setDescription('Danh sách coupon'))
    .addSubcommand((s) => s.setName('coupon-disable').setDescription('Tắt coupon').addStringOption((o) => o.setName('code').setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName('feedback-hide')
        .setDescription('Ẩn feedback vi phạm')
        .addIntegerOption((o) => o.setName('feedback_id').setRequired(true))
        .addStringOption((o) => o.setName('reason').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('feedback-unhide').setDescription('Bỏ ẩn feedback').addIntegerOption((o) => o.setName('feedback_id').setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName('feedback-reply')
        .setDescription('Phản hồi feedback')
        .addIntegerOption((o) => o.setName('feedback_id').setRequired(true))
        .addStringOption((o) => o.setName('reply').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('staff-grant')
        .setDescription('Cấp quyền nhân viên')
        .addUserOption((o) => o.setName('user').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('role')
            .setRequired(true)
            .addChoices(
              { name: 'OWNER', value: 'OWNER' },
              { name: 'ADMINISTRATOR', value: 'ADMINISTRATOR' },
              { name: 'FINANCE', value: 'FINANCE' },
              { name: 'PRODUCT_MANAGER', value: 'PRODUCT_MANAGER' },
              { name: 'SUPPORT', value: 'SUPPORT' },
              { name: 'MODERATOR', value: 'MODERATOR' },
            ),
        ),
    )
    .addSubcommand((s) => s.setName('staff-revoke').setDescription('Thu quyền').addUserOption((o) => o.setName('user').setRequired(true)))
    .addSubcommand((s) => s.setName('staff-list').setDescription('Danh sách nhân viên'))
    .addSubcommand((s) => s.setName('config-show').setDescription('Xem cấu hình guild'))
    .addSubcommand((s) =>
      s
        .setName('config-set')
        .setDescription('Sửa cấu hình (key dạng channels.feedback)')
        .addStringOption((o) => o.setName('key').setRequired(true))
        .addStringOption((o) => o.setName('value').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('announce').setDescription('Thông báo tới channel announcements').addStringOption((o) => o.setName('message').setRequired(true)))
    .addSubcommand((s) => s.setName('verify-setup').setDescription('Đăng message xác minh thành viên'))
    .addSubcommand((s) => s.setName('stats').setDescription('Thống kê cửa hàng')),
  async run(ctx, i) {
    const sub = i.options.getSubcommand(true);
    const gid = guildIdOf(i);

    const permFor: Record<string, Perm> = {
      'product-create': 'products.manage',
      'product-edit': 'products.manage',
      'product-delete': 'products.manage',
      'product-list': 'products.manage',
      'category-add': 'products.manage',
      'inventory-add': 'inventory.manage',
      'order-view': 'orders.view',
      'order-confirm': 'payments.confirm',
      'order-refund': 'payments.refund',
      'order-complete': 'orders.manage',
      'order-redeliver': 'orders.manage',
      'coupon-create': 'coupons.manage',
      'coupon-list': 'coupons.manage',
      'coupon-disable': 'coupons.manage',
      'feedback-hide': 'feedback.manage',
      'feedback-unhide': 'feedback.manage',
      'feedback-reply': 'feedback.manage',
      'staff-grant': 'staff.manage',
      'staff-revoke': 'staff.manage',
      'staff-list': 'staff.manage',
      'config-show': 'config.manage',
      'config-set': 'config.manage',
      announce: 'config.manage',
      'verify-setup': 'config.manage',
      stats: 'stats.view',
    };
    if (!(await guard(ctx, i, permFor[sub] ?? 'config.manage'))) return;

    switch (sub) {
      case 'product-create': {
        const catSlug = i.options.getString('category');
        const cat = catSlug ? await ctx.db.categories.get(catSlug) : null;
        const p = await ctx.db.products.create({
          sku: i.options.getString('sku', true),
          name: i.options.getString('name', true),
          price: i.options.getInteger('price', true),
          categoryId: cat?.id ?? null,
          description: i.options.getString('description') ?? '',
          deliveryMode: (i.options.getString('delivery') as 'AUTO' | 'MANUAL') ?? 'AUTO',
          stockTracked: i.options.getBoolean('stock_tracked') ?? true,
          imageUrl: i.options.getString('image'),
        });
        await i.reply({ content: `✅ Tạo sản phẩm #${p.id} \`${p.sku}\` giá ${formatVnd(p.price)}`, flags: EPHEMERAL });
        return;
      }
      case 'product-edit': {
        const p = await ctx.db.products.update(i.options.getInteger('product_id', true), {
          name: i.options.getString('name') ?? undefined,
          price: i.options.getInteger('price') ?? undefined,
          description: i.options.getString('description') ?? undefined,
          active: i.options.getBoolean('active') ?? undefined,
          imageUrl: i.options.getString('image') ?? undefined,
        });
        await i.reply({ content: p ? `✅ Đã cập nhật #${p.id}` : '⚠️ Không tìm thấy sản phẩm', flags: EPHEMERAL });
        return;
      }
      case 'product-delete': {
        const ok = await ctx.db.products.softDelete(i.options.getInteger('product_id', true));
        await i.reply({ content: ok ? '✅ Đã xoá mềm sản phẩm' : '⚠️ Không tìm thấy', flags: EPHEMERAL });
        return;
      }
      case 'product-list': {
        const products = await ctx.db.products.list({ activeOnly: false, limit: 20 });
        const counts = await ctx.db.inventory.countsByProduct(products.map((p) => p.id));
        await i.reply({
          embeds: emb([
            {
              title: '📦 Sản phẩm',
              color: BRAND,
              description:
                products.map((p) => `#${p.id} \`${p.sku}\` ${p.name} — ${formatVnd(p.price)} · kho: ${p.stockTracked ? (counts.get(p.id) ?? 0) : '∞'} · ${p.active ? '🟢' : '🔴'}`).join('\n') ||
                '(trống)',
            },
          ]),
          flags: EPHEMERAL,
        });
        return;
      }
      case 'category-add': {
        const c = await ctx.db.categories.create({
          slug: i.options.getString('slug', true),
          name: i.options.getString('name', true),
          description: i.options.getString('description'),
        });
        await i.reply({ content: `✅ Danh mục #${c.id} \`${c.slug}\``, flags: EPHEMERAL });
        return;
      }
      case 'inventory-add': {
        const productId = i.options.getInteger('product_id', true);
        const attachment = i.options.getAttachment('file');
        const linesText = i.options.getString('lines');
        if (attachment) {
          if (attachment.size > 1_000_000) throw new AppError('file_too_large', 'File tối đa 1MB');
          const res = await fetch(attachment.url);
          const csv = await res.text();
          const out = await catalog.importInventoryCsv(ctx, { guildId: gid, actorId: i.user.id, csv, productId });
          await i.reply({ content: `✅ Nhập ${out.added} dòng, bỏ qua ${out.skipped} (batch ${out.batch})`, flags: EPHEMERAL });
        } else if (linesText) {
          const out = await catalog.addInventoryLines(ctx, { guildId: gid, actorId: i.user.id, productId, lines: linesText.split('\n') });
          await i.reply({ content: `✅ Nhập ${out.added} dòng (batch ${out.batch})`, flags: EPHEMERAL });
        } else {
          await replyError(i, new AppError('missing_input', 'Cần file csv hoặc danh sách dòng'));
        }
        return;
      }
      case 'order-view': {
        const order = await ctx.db.orders.getByCode(i.options.getInteger('code', true));
        if (!order) {
          await replyError(i, new AppError('not_found', 'Không tìm thấy đơn'));
          return;
        }
        const { items, history, payment } = await orders.orderSummary(ctx, order);
        const embed = orderEmbed(order, items, { history: history.map((h) => STATUS_META[h.toStatus].label) });
        if (payment) {
          embed.fields?.push({
            name: 'Giao dịch',
            value: `${payment.provider} · ${payment.providerRef} · ${formatVnd(payment.amount)} · ${payment.verifiedBy}`,
          });
        }
        await i.reply({ embeds: emb([embed]), flags: EPHEMERAL });
        return;
      }
      case 'order-confirm': {
        const res = await orders.confirmPaymentManual(ctx, {
          guildId: gid,
          actorId: i.user.id,
          orderCode: i.options.getInteger('code', true),
          amount: i.options.getInteger('amount', true),
          providerRef: i.options.getString('ref') ?? undefined,
          note: i.options.getString('note') ?? undefined,
        });
        await i.reply({
          content: res.applied ? `✅ Đơn #${res.orderCode} đã xác nhận thanh toán và chuyển sang giao hàng` : `ℹ️ Không áp dụng: ${res.reason}`,
          flags: EPHEMERAL,
        });
        return;
      }
      case 'order-refund': {
        const ok = await orders.markRefund(ctx, {
          guildId: gid,
          actorId: i.user.id,
          orderCode: i.options.getInteger('code', true),
          stage: i.options.getString('stage', true) as 'pending' | 'done',
          reason: i.options.getString('reason', true),
        });
        await i.reply({ content: ok ? '✅ Đã cập nhật trạng thái hoàn tiền' : '⚠️ Không áp dụng', flags: EPHEMERAL });
        return;
      }
      case 'order-complete': {
        const ok = await orders.completeManual(ctx, { guildId: gid, actorId: i.user.id, orderCode: i.options.getInteger('code', true) });
        await i.reply({ content: ok ? '✅ Đơn đã hoàn thành' : '⚠️ Không áp dụng', flags: EPHEMERAL });
        return;
      }
      case 'order-redeliver': {
        const ok = await orders.redeliver(ctx, { guildId: gid, actorId: i.user.id, orderCode: i.options.getInteger('code', true) });
        await i.reply({ content: ok ? '✅ Đã gửi lại DM sản phẩm' : '⚠️ DM thất bại (người dùng khoá DM)', flags: EPHEMERAL });
        return;
      }
      case 'coupon-create': {
        const expiresDays = i.options.getInteger('expires_days');
        const c = await ctx.db.coupons.create({
          code: i.options.getString('code', true),
          kind: i.options.getString('kind', true) as 'percent' | 'fixed',
          value: i.options.getInteger('value', true),
          maxUses: i.options.getInteger('max_uses'),
          minOrder: i.options.getInteger('min_order') ?? 0,
          expiresAt: expiresDays ? new Date(Date.now() + expiresDays * 86400_000) : null,
          createdBy: i.user.id,
        });
        await i.reply({ content: `✅ Coupon \`${c.code}\` (${c.kind} ${c.value})`, flags: EPHEMERAL });
        return;
      }
      case 'coupon-list': {
        const list = await ctx.db.coupons.list(20);
        await i.reply({
          embeds: emb([
            {
              title: '🎟️ Coupon',
              color: BRAND,
              description:
                list.map((c) => `\`${c.code}\` ${c.kind} ${c.value} · dùng ${c.maxUses ?? '∞'} · ${c.active ? '🟢' : '🔴'}`).join('\n') || '(trống)',
            },
          ]),
          flags: EPHEMERAL,
        });
        return;
      }
      case 'coupon-disable': {
        const c = await ctx.db.coupons.get(i.options.getString('code', true));
        const updated = c ? await ctx.db.coupons.update(c.id, { active: false }) : null;
        await i.reply({ content: updated ? '✅ Đã tắt coupon' : '⚠️ Không tìm thấy', flags: EPHEMERAL });
        return;
      }
      case 'feedback-hide': {
        const row = await feedback.hideFeedback(ctx, {
          guildId: gid,
          actorId: i.user.id,
          feedbackId: i.options.getInteger('feedback_id', true),
          reason: i.options.getString('reason', true),
        });
        await i.reply({ content: row ? '✅ Đã ẩn feedback' : '⚠️ Không tìm thấy', flags: EPHEMERAL });
        return;
      }
      case 'feedback-unhide': {
        const row = await feedback.unhideFeedback(ctx, { guildId: gid, actorId: i.user.id, feedbackId: i.options.getInteger('feedback_id', true) });
        await i.reply({ content: row ? '✅ Đã bỏ ẩn' : '⚠️ Không tìm thấy', flags: EPHEMERAL });
        return;
      }
      case 'feedback-reply': {
        const row = await feedback.replyFeedback(ctx, {
          guildId: gid,
          actorId: i.user.id,
          feedbackId: i.options.getInteger('feedback_id', true),
          reply: i.options.getString('reply', true),
        });
        await i.reply({ content: row ? '✅ Đã phản hồi' : '⚠️ Không tìm thấy', flags: EPHEMERAL });
        return;
      }
      case 'staff-grant': {
        const target = i.options.getUser('user', true);
        const role = i.options.getString('role', true) as never;
        const actor = await resolveStaff(ctx, gid, i.user.id);
        if (!actor || !canManageRole(actor.role, role)) {
          await replyError(i, new AppError('rank', 'Bạn không thể cấp vai trò ngang hoặc cao hơn mình'));
          return;
        }
        await ctx.db.staff.grant(gid, target.id, role, i.user.id);
        await ctx.db.audit.log({ guildId: gid, actorType: 'staff', actorId: i.user.id, action: 'staff.granted', targetType: 'user', targetId: target.id, detail: { role } });
        await i.reply({ content: `✅ Đã cấp ${role} cho ${target.tag}`, flags: EPHEMERAL });
        return;
      }
      case 'staff-revoke': {
        const target = i.options.getUser('user', true);
        const existing = await ctx.db.staff.get(gid, target.id);
        const actor = await resolveStaff(ctx, gid, i.user.id);
        if (existing && actor && !canManageRole(actor.role, existing.role)) {
          await replyError(i, new AppError('rank', 'Không thể thu quyền vai trò ngang hoặc cao hơn'));
          return;
        }
        const ok = await ctx.db.staff.revoke(gid, target.id);
        await ctx.db.audit.log({ guildId: gid, actorType: 'staff', actorId: i.user.id, action: 'staff.revoked', targetType: 'user', targetId: target.id });
        await i.reply({ content: ok ? '✅ Đã thu quyền' : '⚠️ Không có bản ghi', flags: EPHEMERAL });
        return;
      }
      case 'staff-list': {
        const list = await ctx.db.staff.list(gid);
        await i.reply({
          embeds: emb([{ title: '👥 Nhân viên', color: BRAND, description: list.map((s) => `<@${s.discordId}> — ${s.role}`).join('\n') || '(trống)' }]),
          flags: EPHEMERAL,
        });
        return;
      }
      case 'config-show': {
        const settings = await ctx.db.guildConfig.get(gid);
        await i.reply({ content: `\`\`\`json\n${JSON.stringify(settings, null, 2).slice(0, 1900)}\`\`\``, flags: EPHEMERAL });
        return;
      }
      case 'config-set': {
        const key = i.options.getString('key', true);
        const rawValue = i.options.getString('value', true);
        const path = key.split('.');
        if (path.length < 2) throw new AppError('bad_key', 'Key dạng section.field, ví dụ channels.feedback');
        let value: unknown = rawValue;
        if (rawValue === 'true') value = true;
        else if (rawValue === 'false') value = false;
        else if (rawValue === 'null') value = null;
        else if (/^-?\d+$/.test(rawValue)) value = Number(rawValue);
        const patch: Record<string, unknown> = {};
        let cursor = patch;
        path.forEach((part, idx) => {
          if (idx === path.length - 1) cursor[part] = value;
          else cursor = cursor[part] = {};
        });
        const current = await ctx.db.guildConfig.get(gid);
        try {
          const merged = mergeGuildSettings(current, patch);
          await ctx.db.guildConfig.set(gid, merged);
        } catch (err) {
          await replyError(i, new AppError('bad_config', `Cấu hình không hợp lệ: ${(err as Error).message.slice(0, 300)}`));
          return;
        }
        await ctx.db.audit.log({ guildId: gid, actorType: 'staff', actorId: i.user.id, action: 'config.updated', detail: { key, value: rawValue } });
        await i.reply({ content: `✅ Đã cập nhật \`${key}\``, flags: EPHEMERAL });
        return;
      }
      case 'announce': {
        const settings = await ctx.db.guildConfig.get(gid);
        if (!settings.channels.announcements) {
          await replyError(i, new AppError('no_channel', 'Chưa cấu hình channels.announcements'));
          return;
        }
        await ctx.notifier.sendChannel(settings.channels.announcements, {
          embeds: [{ title: '📣 Thông báo', description: i.options.getString('message', true), color: WARN }],
        });
        await ctx.db.audit.log({ guildId: gid, actorType: 'staff', actorId: i.user.id, action: 'announce.sent' });
        await i.reply({ content: '✅ Đã gửi thông báo', flags: EPHEMERAL });
        return;
      }
      case 'verify-setup': {
        const button = new ButtonBuilder().setCustomId(encodeCustomId('ver:confirm', [], 60 * 60 * 24 * 365)).setLabel('✅ Xác minh').setStyle(ButtonStyle.Success);
        const channel = i.channel;
        if (!channel || !('send' in channel)) throw new AppError('no_channel', 'Kênh không hỗ trợ gửi tin nhắn');
        await (channel as { send: (p: unknown) => Promise<unknown> }).send({
          embeds: emb([{ title: '🔐 Xác minh thành viên', description: 'Bấm nút dưới để nhận role và mở quyền truy cập server.', color: BRAND }]),
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
        });
        await i.reply({ content: '✅ Đã đăng message xác minh', flags: EPHEMERAL });
        return;
      }
      case 'stats': {
        const stats = await feedback.shopStats(ctx, gid);
        const byStatus = await ctx.db.orders.countByStatus(gid);
        const revenue = await ctx.db.orders.revenueSince(gid, new Date(Date.now() - 30 * 86400_000));
        await i.reply({
          embeds: emb([
            {
              title: '📊 Thống kê 30 ngày',
              color: BRAND,
              fields: [
                { name: 'Đơn hoàn thành', value: String(stats.completedOrders), inline: true },
                { name: 'Feedback hiển thị', value: String(stats.count), inline: true },
                { name: 'Điểm TB', value: stats.average ? stats.average.toFixed(2) : '—', inline: true },
                { name: 'Doanh thu ghi nhận', value: formatVnd(revenue.total), inline: true },
                { name: 'Số đơn thanh toán', value: String(revenue.count), inline: true },
                { name: 'Theo trạng thái', value: Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join('\n') || '—' },
              ],
              footer: 'Số liệu tính từ dữ liệu thật của hệ thống.',
            },
          ]),
          flags: EPHEMERAL,
        });
        return;
      }
      default:
        await replyError(i, new AppError('unknown_subcommand', sub));
    }
  },
};

/* ------------------------------------------------------------------- mod */

function modRankOk(rank: number): boolean {
  return rank >= ROLE_RANK.MODERATOR;
}

const mod: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Điều hành cộng đồng')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((s) =>
      s
        .setName('timeout')
        .setDescription('Timeout thành viên')
        .addUserOption((o) => o.setName('user').setRequired(true))
        .addIntegerOption((o) => o.setName('minutes').setRequired(true).setMinValue(1).setMaxValue(10080))
        .addStringOption((o) => o.setName('reason').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('kick').setDescription('Kick').addUserOption((o) => o.setName('user').setRequired(true)).addStringOption((o) => o.setName('reason').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('ban').setDescription('Ban').addUserOption((o) => o.setName('user').setRequired(true)).addStringOption((o) => o.setName('reason').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('unban').setDescription('Unban').addStringOption((o) => o.setName('user_id').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('warn').setDescription('Cảnh cáo').addUserOption((o) => o.setName('user').setRequired(true)).addStringOption((o) => o.setName('reason').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('warns').setDescription('Xem cảnh cáo').addUserOption((o) => o.setName('user').setRequired(true)))
    .addSubcommand((s) => s.setName('unwarn').setDescription('Gỡ cảnh cáo').addIntegerOption((o) => o.setName('warn_id').setRequired(true))),
  async run(ctx, i) {
    const gid = guildIdOf(i);
    const staff = await resolveStaff(ctx, gid, i.user.id);
    const member = i.member as GuildMember | null;
    const staffOk = staff ? modRankOk(ROLE_RANK[staff.role]) : false;
    const sub = i.options.getSubcommand(true);
    const needed: Record<string, bigint> = {
      timeout: PermissionFlagsBits.ModerateMembers,
      kick: PermissionFlagsBits.KickMembers,
      ban: PermissionFlagsBits.BanMembers,
      unban: PermissionFlagsBits.BanMembers,
      warn: PermissionFlagsBits.ModerateMembers,
      warns: PermissionFlagsBits.ModerateMembers,
      unwarn: PermissionFlagsBits.ModerateMembers,
    };
    const permOk = member?.permissions.has(needed[sub] ?? PermissionFlagsBits.ModerateMembers) ?? false;
    if (!staffOk && !permOk) {
      await replyError(i, new AppError('permission_denied', 'Bạn không có quyền điều hành'));
      return;
    }
    const target = i.options.getUser('user');
    const reason = i.options.getString('reason') ?? '';

    switch (sub) {
      case 'timeout': {
        const tm = await i.guild?.members.fetch(target!.id);
        if (!tm) throw new AppError('no_member', 'Không tìm thấy thành viên');
        if (member && tm.roles.highest.position >= member.roles.highest.position) throw new AppError('hierarchy', 'Không thể timeout người ngang cấp');
        await tm.timeout(i.options.getInteger('minutes', true) * 60_000, reason);
        await ctx.db.audit.log({ guildId: gid, actorType: 'staff', actorId: i.user.id, action: 'mod.timeout', targetType: 'user', targetId: tm.id, detail: { reason } });
        await i.reply({ content: `✅ Đã timeout ${tm.user.tag}`, flags: EPHEMERAL });
        return;
      }
      case 'kick': {
        const tm = await i.guild?.members.fetch(target!.id);
        if (!tm) throw new AppError('no_member', 'Không tìm thấy thành viên');
        if (member && tm.roles.highest.position >= member.roles.highest.position) throw new AppError('hierarchy', 'Không thể kick người ngang cấp');
        await tm.kick(reason);
        await ctx.db.audit.log({ guildId: gid, actorType: 'staff', actorId: i.user.id, action: 'mod.kick', targetType: 'user', targetId: tm.id, detail: { reason } });
        await i.reply({ content: `✅ Đã kick ${tm.user.tag}`, flags: EPHEMERAL });
        return;
      }
      case 'ban': {
        await i.guild?.members.ban(target!.id, { reason });
        await ctx.db.audit.log({ guildId: gid, actorType: 'staff', actorId: i.user.id, action: 'mod.ban', targetType: 'user', targetId: target!.id, detail: { reason } });
        await i.reply({ content: `✅ Đã ban ${target!.tag}`, flags: EPHEMERAL });
        return;
      }
      case 'unban': {
        await i.guild?.members.unban(i.options.getString('user_id', true), reason);
        await ctx.db.audit.log({ guildId: gid, actorType: 'staff', actorId: i.user.id, action: 'mod.unban', targetType: 'user', targetId: i.options.getString('user_id', true) });
        await i.reply({ content: '✅ Đã unban', flags: EPHEMERAL });
        return;
      }
      case 'warn': {
        const warn = await ctx.db.warns.add({ guildId: gid, userId: target!.id, moderatorId: i.user.id, reason });
        const count = await ctx.db.warns.countActive(gid, target!.id);
        await ctx.notifier.sendDM(target!.id, { content: `⚠️ Bạn bị cảnh cáo tại server: ${reason} (lần ${count})` });
        await ctx.db.audit.log({ guildId: gid, actorType: 'staff', actorId: i.user.id, action: 'mod.warn', targetType: 'user', targetId: target!.id, detail: { reason, warnId: warn.id } });
        await i.reply({ content: `✅ Đã cảnh cáo ${target!.tag} (tổng ${count} lần hiệu lực)`, flags: EPHEMERAL });
        return;
      }
      case 'warns': {
        const list = await ctx.db.warns.list(gid, target!.id);
        await i.reply({
          embeds: emb([
            {
              title: `📋 Warn của ${target!.tag}`,
              color: WARN,
              description: list.map((w) => `#${w.id} ${w.active ? '🟡' : '⚪'} ${w.reason} · <t:${Math.floor(w.createdAt.getTime() / 1000)}:d>`).join('\n') || '(không có)',
            },
          ]),
          flags: EPHEMERAL,
        });
        return;
      }
      case 'unwarn': {
        const ok = await ctx.db.warns.setActive(i.options.getInteger('warn_id', true), false);
        await ctx.db.audit.log({ guildId: gid, actorType: 'staff', actorId: i.user.id, action: 'mod.unwarn', targetId: String(i.options.getInteger('warn_id', true)) });
        await i.reply({ content: ok ? '✅ Đã gỡ warn' : '⚠️ Không tìm thấy', flags: EPHEMERAL });
        return;
      }
      default:
        await replyError(i, new AppError('unknown_subcommand', sub));
    }
  },
};

export const commandModules: CommandModule[] = [shop, donHang, lichSu, danhGia, ticket, faq, help, loiMoi, admin, mod];

export { AttachmentBuilder };
