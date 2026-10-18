import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  varchar,
} from 'drizzle-orm/pg-core';

export const orderStatusEnum = pgEnum('order_status', [
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'REFUND_PENDING',
  'REFUNDED',
  'MANUAL_REVIEW',
]);

export const inventoryStatusEnum = pgEnum('inventory_status', [
  'AVAILABLE',
  'RESERVED',
  'SOLD',
  'RETURNED',
  'DEFECTIVE',
]);

export const deliveryModeEnum = pgEnum('delivery_mode', ['AUTO', 'MANUAL']);

export const feedbackStatusEnum = pgEnum('feedback_status', ['VISIBLE', 'HIDDEN']);

export const ticketStatusEnum = pgEnum('ticket_status', ['OPEN', 'PENDING', 'CLOSED']);

export const staffRoleEnum = pgEnum('staff_role', [
  'OWNER',
  'ADMINISTRATOR',
  'FINANCE',
  'PRODUCT_MANAGER',
  'SUPPORT',
  'MODERATOR',
]);

export const orderCodeSeq = pgSequence('order_code_seq', { startWith: 100001 });

export const users = pgTable('users', {
  id: text('id').primaryKey(), // discord user id
  username: text('username').notNull(),
  globalName: text('global_name'),
  referralCode: text('referral_code').unique(),
  loyaltyPoints: integer('loyalty_points').notNull().default(0), // derived cache; source of truth = loyalty_ledger
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const guildConfigs = pgTable('guild_configs', {
  guildId: text('guild_id').primaryKey(),
  settings: jsonb('settings').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const staffPermissions = pgTable(
  'staff_permissions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    guildId: text('guild_id').notNull(),
    discordId: text('discord_id').notNull(),
    role: staffRoleEnum('role').notNull(),
    grantedBy: text('granted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('staff_guild_user_uniq').on(t.guildId, t.discordId)],
);

export const categories = pgTable('categories', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  slug: varchar('slug', { length: 64 }).unique().notNull(),
  name: text('name').notNull(),
  description: text('description'),
  position: integer('position').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  'products',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sku: varchar('sku', { length: 64 }).unique().notNull(),
    categoryId: bigint('category_id', { mode: 'number' }).references(() => categories.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    price: integer('price').notNull(), // VND, integer
    imageUrl: text('image_url'),
    deliveryMode: deliveryModeEnum('delivery_mode').notNull().default('AUTO'),
    stockTracked: boolean('stock_tracked').notNull().default(true),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(5),
    active: boolean('active').notNull().default(true),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('products_active_idx').on(t.active, t.categoryId)],
);

export const productVariants = pgTable('product_variants', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  productId: bigint('product_id', { mode: 'number' })
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  priceDelta: integer('price_delta').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    productId: bigint('product_id', { mode: 'number' })
      .notNull()
      .references(() => products.id),
    variantId: bigint('variant_id', { mode: 'number' }).references(() => productVariants.id),
    secretCiphertext: text('secret_ciphertext').notNull(), // AES-256-GCM encrypted payload
    status: inventoryStatusEnum('status').notNull().default('AVAILABLE'),
    orderId: bigint('order_id', { mode: 'number' }),
    batch: text('batch'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('inventory_available_idx').on(t.productId, t.variantId, t.status),
    index('inventory_order_idx').on(t.orderId),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    code: integer('code').notNull().unique().default(sql`nextval('order_code_seq')`),
    guildId: text('guild_id').notNull(),
    buyerId: text('buyer_id').notNull().references(() => users.id),
    status: orderStatusEnum('status').notNull().default('PENDING_PAYMENT'),
    subtotal: integer('subtotal').notNull(),
    discount: integer('discount').notNull().default(0),
    total: integer('total').notNull(),
    couponId: bigint('coupon_id', { mode: 'number' }),
    paymentTransferCode: text('payment_transfer_code').notNull(), // bank transfer content, e.g. M100042
    paymentProvider: text('payment_provider').notNull(),
    paymentRef: text('payment_ref'), // provider payment link / id
    paymentExpiresAt: timestamp('payment_expires_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_buyer_idx').on(t.buyerId, t.createdAt),
    index('orders_status_idx').on(t.status),
    index('orders_guild_idx').on(t.guildId, t.createdAt),
  ],
);

export const orderItems = pgTable('order_items', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  orderId: bigint('order_id', { mode: 'number' })
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  productId: bigint('product_id', { mode: 'number' }).references(() => products.id),
  variantId: bigint('variant_id', { mode: 'number' }).references(() => productVariants.id),
  productName: text('product_name').notNull(), // snapshot at purchase time
  unitPrice: integer('unit_price').notNull(),
  quantity: integer('quantity').notNull(),
  lineTotal: integer('line_total').notNull(),
});

export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint('order_id', { mode: 'number' })
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fromStatus: orderStatusEnum('from_status'),
    toStatus: orderStatusEnum('to_status').notNull(),
    reason: text('reason'),
    actorType: text('actor_type').notNull(), // system | staff | provider
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('order_history_order_idx').on(t.orderId)],
);

export const paymentEvents = pgTable(
  'payment_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    orderCode: integer('order_code'),
    payload: jsonb('payload').notNull(),
    signatureStatus: text('signature_status').notNull(), // valid | invalid | none
    processed: boolean('processed').notNull().default(false),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payment_event_uniq').on(t.provider, t.providerEventId)],
);

export const paymentTransactions = pgTable(
  'payment_transactions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint('order_id', { mode: 'number' })
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' })
      .unique(),
    provider: text('provider').notNull(),
    providerRef: text('provider_ref').notNull(),
    amount: integer('amount').notNull(),
    expectedAmount: integer('expected_amount').notNull(),
    status: text('status').notNull(), // success | amount_mismatch | refunded
    verifiedBy: text('verified_by').notNull(), // provider_webhook | staff
    verifierId: text('verifier_id'),
    counterAccount: text('counter_account'),
    counterAccountName: text('counter_account_name'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payment_tx_provider_ref_uniq').on(t.provider, t.providerRef)],
);

export const coupons = pgTable('coupons', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  code: varchar('code', { length: 32 }).unique().notNull(),
  kind: text('kind').notNull(), // percent | fixed
  value: integer('value').notNull(),
  maxUses: integer('max_uses'),
  perUserLimit: integer('per_user_limit').notNull().default(1),
  minOrder: integer('min_order').notNull().default(0),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    couponId: bigint('coupon_id', { mode: 'number' })
      .notNull()
      .references(() => coupons.id),
    orderId: bigint('order_id', { mode: 'number' }).notNull().references(() => orders.id),
    userId: text('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('coupon_redemption_order_uniq').on(t.orderId)],
);

export const feedbacks = pgTable(
  'feedbacks',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint('order_id', { mode: 'number' })
      .notNull()
      .references(() => orders.id)
      .unique(),
    guildId: text('guild_id').notNull(),
    authorId: text('author_id').notNull(),
    rating: integer('rating').notNull(),
    content: text('content').notNull().default(''),
    status: feedbackStatusEnum('status').notNull().default('VISIBLE'),
    hiddenReason: text('hidden_reason'),
    shopReply: text('shop_reply'),
    messageUrl: text('message_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('feedback_guild_idx').on(t.guildId, t.status)],
);

export const tickets = pgTable(
  'tickets',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    code: varchar('code', { length: 24 }).unique().notNull(),
    guildId: text('guild_id').notNull(),
    openerId: text('opener_id').notNull(),
    subject: text('subject').notNull(),
    status: ticketStatusEnum('status').notNull().default('OPEN'),
    channelId: text('channel_id'),
    orderId: bigint('order_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('ticket_guild_idx').on(t.guildId, t.status)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    guildId: text('guild_id'),
    actorType: text('actor_type').notNull(), // system | staff | provider | user
    actorId: text('actor_id'),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 32 }),
    targetId: text('target_id'),
    detail: jsonb('detail').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_action_idx').on(t.action, t.createdAt), index('audit_guild_idx').on(t.guildId, t.createdAt)],
);

export const loyaltyLedger = pgTable(
  'loyalty_ledger',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: text('user_id').notNull().references(() => users.id),
    delta: integer('delta').notNull(),
    reason: varchar('reason', { length: 64 }).notNull(),
    orderId: bigint('order_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('loyalty_user_idx').on(t.userId, t.createdAt)],
);

export const referrals = pgTable(
  'referrals',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    referrerId: text('referrer_id').notNull(),
    referredId: text('referred_id').notNull().unique(),
    rewardedAt: timestamp('rewarded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('referral_referrer_idx').on(t.referrerId)],
);

export const warns = pgTable(
  'warns',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    moderatorId: text('moderator_id').notNull(),
    reason: text('reason').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('warn_user_idx').on(t.guildId, t.userId)],
);
