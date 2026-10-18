import { and, avg, count, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { OutOfStockError } from '../core/errors.js';
import { parseGuildSettings, type GuildSettings } from '../services/guild-settings.js';
import * as s from './schema.js';
import type {
  AuditEntry,
  AuditFilter,
  Db,
  FeedbackFilter,
  OrderFilter,
  OrderInsert,
  OrderItemInsert,
  ProductFilter,
  TransitionMeta,
} from './repo.js';
import type { OrderStatus, StaffRole } from './types.js';

type TxDb = PostgresJsDatabase<typeof s>;

export class DrizzleDb implements Db {
  readonly kind = 'postgres' as const;
  constructor(
    private readonly client: TxDb,
    private readonly root?: DrizzleDb,
  ) {}

  get base(): DrizzleDb {
    return this.root ?? this;
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    // Nested tx calls reuse the ambient transaction (this instance).
    if (this.root) return fn(this);
    return this.client.transaction(async (txc) => fn(new DrizzleDb(txc, this)));
  }

  private get d(): TxDb {
    return this.client;
  }

  users: Db['users'] = {
    upsert: async (input) => {
      const [row] = await this.d
        .insert(s.users)
        .values({ id: input.id, username: input.username, globalName: input.globalName ?? null })
        .onConflictDoUpdate({
          target: s.users.id,
          set: { username: input.username, globalName: input.globalName ?? null, updatedAt: new Date() },
        })
        .returning();
      return row!;
    },
    get: async (id) => {
      const [row] = await this.d.select().from(s.users).where(eq(s.users.id, id)).limit(1);
      return row ?? null;
    },
    getByReferralCode: async (code) => {
      const [row] = await this.d.select().from(s.users).where(eq(s.users.referralCode, code)).limit(1);
      return row ?? null;
    },
    setReferralCode: async (id, code) => {
      await this.d.update(s.users).set({ referralCode: code, updatedAt: new Date() }).where(eq(s.users.id, id));
    },
    addLoyaltyCache: async (id, delta) => {
      await this.d
        .update(s.users)
        .set({ loyaltyPoints: sql`${s.users.loyaltyPoints} + ${delta}`, updatedAt: new Date() })
        .where(eq(s.users.id, id));
    },
  };

  categories: Db['categories'] = {
    list: async (opts) =>
      this.d
        .select()
        .from(s.categories)
        .where(opts?.activeOnly ? eq(s.categories.active, true) : undefined)
        .orderBy(s.categories.position),
    get: async (idOrSlug) => {
      const where = typeof idOrSlug === 'number' ? eq(s.categories.id, idOrSlug) : eq(s.categories.slug, idOrSlug);
      const [row] = await this.d.select().from(s.categories).where(where).limit(1);
      return row ?? null;
    },
    create: async (input) => {
      const [row] = await this.d
        .insert(s.categories)
        .values({
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          position: input.position ?? 0,
        })
        .returning();
      return row!;
    },
    update: async (id, patch) => {
      const [row] = await this.d.update(s.categories).set(patch).where(eq(s.categories.id, id)).returning();
      return row ?? null;
    },
  };

  products: Db['products'] = {
    list: async (filter: ProductFilter = {}) => {
      const conds: SQL[] = [isNull(s.products.deletedAt)];
      if (filter.activeOnly) conds.push(eq(s.products.active, true));
      if (filter.categoryId !== undefined) conds.push(eq(s.products.categoryId, filter.categoryId));
      if (filter.search) conds.push(ilike(s.products.name, `%${filter.search}%`));
      return this.d
        .select()
        .from(s.products)
        .where(and(...conds))
        .limit(filter.limit ?? 50)
        .offset(filter.offset ?? 0);
    },
    get: async (id) => {
      const [row] = await this.d
        .select()
        .from(s.products)
        .where(and(eq(s.products.id, id), isNull(s.products.deletedAt)))
        .limit(1);
      return row ?? null;
    },
    getBySku: async (sku) => {
      const [row] = await this.d
        .select()
        .from(s.products)
        .where(and(eq(s.products.sku, sku), isNull(s.products.deletedAt)))
        .limit(1);
      return row ?? null;
    },
    create: async (input) => {
      const [row] = await this.d
        .insert(s.products)
        .values({
          sku: input.sku,
          categoryId: input.categoryId ?? null,
          name: input.name,
          description: input.description ?? '',
          price: input.price,
          imageUrl: input.imageUrl ?? null,
          deliveryMode: input.deliveryMode ?? 'AUTO',
          stockTracked: input.stockTracked ?? true,
          lowStockThreshold: input.lowStockThreshold ?? 5,
        })
        .returning();
      return row!;
    },
    update: async (id, patch) => {
      const [row] = await this.d
        .update(s.products)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(s.products.id, id), isNull(s.products.deletedAt)))
        .returning();
      return row ?? null;
    },
    softDelete: async (id) => {
      const [row] = await this.d
        .update(s.products)
        .set({ deletedAt: new Date() })
        .where(and(eq(s.products.id, id), isNull(s.products.deletedAt)))
        .returning();
      return !!row;
    },
    variants: async (productId) =>
      this.d.select().from(s.productVariants).where(eq(s.productVariants.productId, productId)),
    addVariant: async (input) => {
      const [row] = await this.d
        .insert(s.productVariants)
        .values({ productId: input.productId, name: input.name, priceDelta: input.priceDelta ?? 0 })
        .returning();
      return row!;
    },
  };

  inventory: Db['inventory'] = {
    add: async (items) => {
      if (!items.length) return 0;
      await this.d.insert(s.inventoryItems).values(
        items.map((it) => ({
          productId: it.productId,
          variantId: it.variantId ?? null,
          secretCiphertext: it.ciphertext,
          batch: it.batch ?? null,
        })),
      );
      return items.length;
    },
    reserve: async (productId, variantId, qty, orderId) => {
      const variantCond =
        variantId === null || variantId === undefined
          ? sql`${s.inventoryItems.variantId} is null`
          : sql`${s.inventoryItems.variantId} = ${variantId}`;
      const rows = await this.d
        .update(s.inventoryItems)
        .set({ status: 'RESERVED', orderId, updatedAt: new Date() })
        .where(
          sql`${s.inventoryItems.id} in (
            select id from inventory_items
            where product_id = ${productId} and ${variantCond} and status = 'AVAILABLE'
            order by id for update skip locked
            limit ${qty}
          )`,
        )
        .returning({ id: s.inventoryItems.id });
      if (rows.length < qty) {
        // release partial reservation of this call (should not happen: single statement)
        const [p] = await this.d.select({ name: s.products.name }).from(s.products).where(eq(s.products.id, productId)).limit(1);
        throw new OutOfStockError([p?.name ?? `product#${productId}`]);
      }
      return rows.map((r) => r.id);
    },
    releaseForOrder: async (orderId) => {
      const rows = await this.d
        .update(s.inventoryItems)
        .set({ status: 'AVAILABLE', orderId: null, updatedAt: new Date() })
        .where(and(eq(s.inventoryItems.orderId, orderId), eq(s.inventoryItems.status, 'RESERVED')))
        .returning({ id: s.inventoryItems.id });
      return rows.length;
    },
    sellForOrder: async (orderId) => {
      const rows = await this.d
        .update(s.inventoryItems)
        .set({ status: 'SOLD', updatedAt: new Date() })
        .where(and(eq(s.inventoryItems.orderId, orderId), eq(s.inventoryItems.status, 'RESERVED')))
        .returning({ id: s.inventoryItems.id });
      return rows.length;
    },
    restockForOrder: async (orderId) => {
      const rows = await this.d
        .update(s.inventoryItems)
        .set({ status: 'AVAILABLE', orderId: null, updatedAt: new Date() })
        .where(and(eq(s.inventoryItems.orderId, orderId), eq(s.inventoryItems.status, 'SOLD')))
        .returning({ id: s.inventoryItems.id });
      return rows.length;
    },
    ciphertextsForOrder: async (orderId) =>
      this.d
        .select()
        .from(s.inventoryItems)
        .where(and(eq(s.inventoryItems.orderId, orderId), inArray(s.inventoryItems.status, ['SOLD', 'RESERVED']))),
    availableCount: async (productId, variantId) => {
      const cond =
        variantId === null || variantId === undefined
          ? isNull(s.inventoryItems.variantId)
          : eq(s.inventoryItems.variantId, variantId);
      const [row] = await this.d
        .select({ n: count() })
        .from(s.inventoryItems)
        .where(and(eq(s.inventoryItems.productId, productId), cond, eq(s.inventoryItems.status, 'AVAILABLE')));
      return row?.n ?? 0;
    },
    countsByProduct: async (productIds) => {
      const m = new Map<number, number>();
      if (!productIds.length) return m;
      const rows = await this.d
        .select({ productId: s.inventoryItems.productId, n: count() })
        .from(s.inventoryItems)
        .where(and(inArray(s.inventoryItems.productId, productIds), eq(s.inventoryItems.status, 'AVAILABLE')))
        .groupBy(s.inventoryItems.productId);
      for (const r of rows) m.set(r.productId, r.n);
      return m;
    },
    list: async (filter) => {
      const conds: SQL[] = [];
      if (filter.productId !== undefined) conds.push(eq(s.inventoryItems.productId, filter.productId));
      if (filter.status) conds.push(eq(s.inventoryItems.status, filter.status));
      return this.d
        .select()
        .from(s.inventoryItems)
        .where(conds.length ? and(...conds) : undefined)
        .limit(filter.limit ?? 100)
        .offset(filter.offset ?? 0);
    },
    markDefective: async (ids) => {
      if (!ids.length) return 0;
      const rows = await this.d
        .update(s.inventoryItems)
        .set({ status: 'DEFECTIVE', updatedAt: new Date() })
        .where(and(inArray(s.inventoryItems.id, ids), eq(s.inventoryItems.status, 'AVAILABLE')))
        .returning({ id: s.inventoryItems.id });
      return rows.length;
    },
  };

  orders: Db['orders'] = {
    insert: async (input: OrderInsert, items: OrderItemInsert[]) => {
      const [row] = await this.d
        .insert(s.orders)
        .values({
          guildId: input.guildId,
          buyerId: input.buyerId,
          subtotal: input.subtotal,
          discount: input.discount,
          total: input.total,
          couponId: input.couponId,
          paymentTransferCode: input.paymentTransferCode,
          paymentProvider: input.paymentProvider,
          paymentExpiresAt: input.paymentExpiresAt,
          note: input.note ?? null,
        })
        .returning();
      const order = row!;
      if (items.length) {
        await this.d.insert(s.orderItems).values(items.map((it) => ({ ...it, orderId: order.id })));
      }
      await this.d.insert(s.orderStatusHistory).values({
        orderId: order.id,
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
        reason: 'order created',
        actorType: 'system',
        actorId: input.buyerId,
      });
      return order;
    },
    get: async (id) => {
      const [row] = await this.d.select().from(s.orders).where(eq(s.orders.id, id)).limit(1);
      return row ?? null;
    },
    getByCode: async (code) => {
      const [row] = await this.d.select().from(s.orders).where(eq(s.orders.code, code)).limit(1);
      return row ?? null;
    },
    list: async (filter: OrderFilter = {}) => {
      const conds: SQL[] = [];
      if (filter.guildId) conds.push(eq(s.orders.guildId, filter.guildId));
      if (filter.status) conds.push(eq(s.orders.status, filter.status));
      if (filter.buyerId) conds.push(eq(s.orders.buyerId, filter.buyerId));
      return this.d
        .select()
        .from(s.orders)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(s.orders.createdAt))
        .limit(filter.limit ?? 50)
        .offset(filter.offset ?? 0);
    },
    items: async (orderId) => this.d.select().from(s.orderItems).where(eq(s.orderItems.orderId, orderId)),
    transition: async (orderId, from: OrderStatus | null, to: OrderStatus, meta: TransitionMeta) => {
      const [cur] = await this.d.select().from(s.orders).where(eq(s.orders.id, orderId)).for('update').limit(1);
      if (!cur) return false;
      if (from !== null && cur.status !== from) return false;
      const set: Partial<typeof s.orders.$inferInsert> = { status: to, updatedAt: new Date() };
      if (meta.paidAt) set.paidAt = meta.paidAt;
      else if (to === 'PAID') set.paidAt = new Date();
      if (meta.completedAt) set.completedAt = meta.completedAt;
      else if (to === 'COMPLETED') set.completedAt = new Date();
      if (meta.cancelReason !== undefined) set.cancelReason = meta.cancelReason;
      if (meta.paymentRef) set.paymentRef = meta.paymentRef;
      await this.d.update(s.orders).set(set).where(eq(s.orders.id, orderId));
      await this.d.insert(s.orderStatusHistory).values({
        orderId,
        fromStatus: cur.status,
        toStatus: to,
        reason: meta.reason ?? null,
        actorType: meta.actorType,
        actorId: meta.actorId ?? null,
      });
      return true;
    },
    setPaymentDetails: async (orderId, patch) => {
      await this.d.update(s.orders).set({ ...patch, updatedAt: new Date() }).where(eq(s.orders.id, orderId));
    },
    history: async (orderId) =>
      this.d.select().from(s.orderStatusHistory).where(eq(s.orderStatusHistory.orderId, orderId)).orderBy(s.orderStatusHistory.createdAt),
    expirable: async (cutoff, limit = 100) =>
      this.d
        .select()
        .from(s.orders)
        .where(and(eq(s.orders.status, 'PENDING_PAYMENT' as OrderStatus), sql`${s.orders.paymentExpiresAt} <= ${cutoff}`))
        .limit(limit),
    countByStatus: async (guildId) => {
      const rows = await this.d
        .select({ status: s.orders.status, n: count() })
        .from(s.orders)
        .where(eq(s.orders.guildId, guildId))
        .groupBy(s.orders.status);
      const out: Record<string, number> = {};
      for (const r of rows) out[r.status] = r.n;
      return out;
    },
    revenueSince: async (guildId, since) => {
      const [row] = await this.d
        .select({ count: count(), total: sql<number>`coalesce(sum(${s.orders.total}), 0)` })
        .from(s.orders)
        .where(
          and(
            eq(s.orders.guildId, guildId),
            inArray(s.orders.status, ['PAID', 'PROCESSING', 'COMPLETED']),
            sql`${s.orders.createdAt} >= ${since}`,
          ),
        );
      return { count: row?.count ?? 0, total: Number(row?.total ?? 0) };
    },
  };

  payments: Db['payments'] = {
    insertEvent: async (input) => {
      const inserted = await this.d
        .insert(s.paymentEvents)
        .values(input)
        .onConflictDoNothing({ target: [s.paymentEvents.provider, s.paymentEvents.providerEventId] })
        .returning();
      if (inserted[0]) return { status: 'inserted', row: inserted[0] };
      const [row] = await this.d
        .select()
        .from(s.paymentEvents)
        .where(
          and(eq(s.paymentEvents.provider, input.provider), eq(s.paymentEvents.providerEventId, input.providerEventId)),
        )
        .limit(1);
      return { status: 'duplicate', row: row! };
    },
    markEventProcessed: async (id) => {
      await this.d.update(s.paymentEvents).set({ processed: true }).where(eq(s.paymentEvents.id, id));
    },
    createTransaction: async (input) => {
      const inserted = await this.d
        .insert(s.paymentTransactions)
        .values(input)
        .onConflictDoNothing({ target: [s.paymentTransactions.provider, s.paymentTransactions.providerRef] })
        .returning();
      return inserted[0] ? 'created' : 'duplicate';
    },
    getByOrder: async (orderId) => {
      const [row] = await this.d.select().from(s.paymentTransactions).where(eq(s.paymentTransactions.orderId, orderId)).limit(1);
      return row ?? null;
    },
  };

  coupons: Db['coupons'] = {
    get: async (code) => {
      const [row] = await this.d.select().from(s.coupons).where(eq(s.coupons.code, code.toUpperCase())).limit(1);
      return row ?? null;
    },
    getById: async (id) => {
      const [row] = await this.d.select().from(s.coupons).where(eq(s.coupons.id, id)).limit(1);
      return row ?? null;
    },
    list: async (limit = 50) => this.d.select().from(s.coupons).limit(limit),
    create: async (input) => {
      const [row] = await this.d
        .insert(s.coupons)
        .values({
          code: input.code.toUpperCase(),
          kind: input.kind,
          value: input.value,
          maxUses: input.maxUses ?? null,
          perUserLimit: input.perUserLimit ?? 1,
          minOrder: input.minOrder ?? 0,
          startsAt: input.startsAt ?? null,
          expiresAt: input.expiresAt ?? null,
          createdBy: input.createdBy ?? null,
        })
        .returning();
      return row!;
    },
    update: async (id, patch) => {
      const [row] = await this.d.update(s.coupons).set(patch).where(eq(s.coupons.id, id)).returning();
      return row ?? null;
    },
    redeem: async (couponId, orderId, userId) => {
      const [coupon] = await this.d.select().from(s.coupons).where(eq(s.coupons.id, couponId)).for('update').limit(1);
      if (!coupon) return 'limit_total';
      const [totalRow] = await this.d
        .select({ n: count() })
        .from(s.couponRedemptions)
        .where(eq(s.couponRedemptions.couponId, couponId));
      const total = totalRow?.n ?? 0;
      if (coupon.maxUses !== null && total >= coupon.maxUses) return 'limit_total';
      const [userRow] = await this.d
        .select({ n: count() })
        .from(s.couponRedemptions)
        .where(and(eq(s.couponRedemptions.couponId, couponId), eq(s.couponRedemptions.userId, userId)));
      const perUser = userRow?.n ?? 0;
      if (perUser >= coupon.perUserLimit) return 'limit_user';
      await this.d.insert(s.couponRedemptions).values({ couponId, orderId, userId });
      return 'ok';
    },
    uses: async (couponId) => {
      const [row] = await this.d.select({ n: count() }).from(s.couponRedemptions).where(eq(s.couponRedemptions.couponId, couponId));
      return row?.n ?? 0;
    },
    userUses: async (couponId, userId) => {
      const [row] = await this.d
        .select({ n: count() })
        .from(s.couponRedemptions)
        .where(and(eq(s.couponRedemptions.couponId, couponId), eq(s.couponRedemptions.userId, userId)));
      return row?.n ?? 0;
    },
  };

  feedback: Db['feedback'] = {
    create: async (input) => {
      const [row] = await this.d.insert(s.feedbacks).values(input).returning();
      return row!;
    },
    getByOrder: async (orderId) => {
      const [row] = await this.d.select().from(s.feedbacks).where(eq(s.feedbacks.orderId, orderId)).limit(1);
      return row ?? null;
    },
    list: async (filter: FeedbackFilter = {}) => {
      const conds: SQL[] = [];
      if (filter.guildId) conds.push(eq(s.feedbacks.guildId, filter.guildId));
      if (filter.status) conds.push(eq(s.feedbacks.status, filter.status));
      return this.d
        .select()
        .from(s.feedbacks)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(s.feedbacks.createdAt))
        .limit(filter.limit ?? 50)
        .offset(filter.offset ?? 0);
    },
    update: async (id, patch) => {
      const [row] = await this.d
        .update(s.feedbacks)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(s.feedbacks.id, id))
        .returning();
      return row ?? null;
    },
    stats: async (guildId) => {
      const [fb] = await this.d
        .select({ n: count(), average: avg(s.feedbacks.rating) })
        .from(s.feedbacks)
        .where(and(eq(s.feedbacks.guildId, guildId), eq(s.feedbacks.status, 'VISIBLE')));
      const [co] = await this.d
        .select({ n: count() })
        .from(s.orders)
        .where(and(eq(s.orders.guildId, guildId), eq(s.orders.status, 'COMPLETED')));
      return {
        count: fb?.n ?? 0,
        average: fb?.average ? Math.round(Number(fb.average) * 100) / 100 : 0,
        completedOrders: co?.n ?? 0,
      };
    },
  };

  tickets: Db['tickets'] = {
    create: async (input) => {
      const [row] = await this.d.insert(s.tickets).values(input).returning();
      return row!;
    },
    getByCode: async (code) => {
      const [row] = await this.d.select().from(s.tickets).where(eq(s.tickets.code, code)).limit(1);
      return row ?? null;
    },
    getById: async (id) => {
      const [row] = await this.d.select().from(s.tickets).where(eq(s.tickets.id, id)).limit(1);
      return row ?? null;
    },
    list: async (filter) => {
      const conds: SQL[] = [];
      if (filter.guildId) conds.push(eq(s.tickets.guildId, filter.guildId));
      if (filter.status) conds.push(eq(s.tickets.status, filter.status));
      return this.d
        .select()
        .from(s.tickets)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(s.tickets.createdAt))
        .limit(filter.limit ?? 50)
        .offset(filter.offset ?? 0);
    },
    update: async (id, patch) => {
      const [row] = await this.d.update(s.tickets).set(patch).where(eq(s.tickets.id, id)).returning();
      return row ?? null;
    },
  };

  audit: Db['audit'] = {
    log: async (entry: AuditEntry) => {
      await this.d.insert(s.auditLogs).values({
        guildId: entry.guildId ?? null,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        detail: entry.detail ?? {},
      });
    },
    list: async (filter: AuditFilter = {}) => {
      const conds: SQL[] = [];
      if (filter.guildId) conds.push(eq(s.auditLogs.guildId, filter.guildId));
      if (filter.action) conds.push(eq(s.auditLogs.action, filter.action));
      return this.d
        .select()
        .from(s.auditLogs)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(s.auditLogs.createdAt))
        .limit(filter.limit ?? 100)
        .offset(filter.offset ?? 0);
    },
  };

  loyalty: Db['loyalty'] = {
    add: async (userId, delta, reason, orderId) => {
      await this.d.insert(s.loyaltyLedger).values({ userId, delta, reason, orderId: orderId ?? null });
      await this.users.addLoyaltyCache(userId, delta);
    },
    entries: async (userId, limit = 50) =>
      this.d.select().from(s.loyaltyLedger).where(eq(s.loyaltyLedger.userId, userId)).orderBy(desc(s.loyaltyLedger.createdAt)).limit(limit),
  };

  referrals: Db['referrals'] = {
    link: async (referrerId, referredId) => {
      if (referrerId === referredId) return 'self';
      const [cycle] = await this.d
        .select()
        .from(s.referrals)
        .where(and(eq(s.referrals.referrerId, referredId), eq(s.referrals.referredId, referrerId)))
        .limit(1);
      if (cycle) return 'self';
      const inserted = await this.d
        .insert(s.referrals)
        .values({ referrerId, referredId })
        .onConflictDoNothing({ target: s.referrals.referredId })
        .returning();
      return inserted[0] ? 'ok' : 'exists';
    },
    getByReferred: async (id) => {
      const [row] = await this.d.select().from(s.referrals).where(eq(s.referrals.referredId, id)).limit(1);
      return row ?? null;
    },
    markRewarded: async (id) => {
      await this.d.update(s.referrals).set({ rewardedAt: new Date() }).where(eq(s.referrals.id, id));
    },
    countByReferrer: async (id) => {
      const [row] = await this.d.select({ n: count() }).from(s.referrals).where(eq(s.referrals.referrerId, id));
      return row?.n ?? 0;
    },
  };

  staff: Db['staff'] = {
    get: async (guildId, discordId) => {
      const [row] = await this.d
        .select()
        .from(s.staffPermissions)
        .where(and(eq(s.staffPermissions.guildId, guildId), eq(s.staffPermissions.discordId, discordId)))
        .limit(1);
      return row ?? null;
    },
    list: async (guildId) => this.d.select().from(s.staffPermissions).where(eq(s.staffPermissions.guildId, guildId)),
    listForUser: async (discordId) => this.d.select().from(s.staffPermissions).where(eq(s.staffPermissions.discordId, discordId)),
    grant: async (guildId, discordId, role: StaffRole, grantedBy) => {
      const [row] = await this.d
        .insert(s.staffPermissions)
        .values({ guildId, discordId, role, grantedBy })
        .onConflictDoUpdate({
          target: [s.staffPermissions.guildId, s.staffPermissions.discordId],
          set: { role },
        })
        .returning();
      return row!;
    },
    revoke: async (guildId, discordId) => {
      const rows = await this.d
        .delete(s.staffPermissions)
        .where(and(eq(s.staffPermissions.guildId, guildId), eq(s.staffPermissions.discordId, discordId)))
        .returning({ id: s.staffPermissions.id });
      return rows.length > 0;
    },
  };

  guildConfig: Db['guildConfig'] = {
    get: async (guildId) => {
      const [row] = await this.d.select().from(s.guildConfigs).where(eq(s.guildConfigs.guildId, guildId)).limit(1);
      return parseGuildSettings(row?.settings ?? {});
    },
    set: async (guildId, settings: GuildSettings) => {
      await this.d
        .insert(s.guildConfigs)
        .values({ guildId, settings, updatedAt: new Date() })
        .onConflictDoUpdate({ target: s.guildConfigs.guildId, set: { settings, updatedAt: new Date() } });
    },
    listGuilds: async () => {
      const rows = await this.d.select({ guildId: s.guildConfigs.guildId }).from(s.guildConfigs);
      return rows.map((r) => r.guildId);
    },
  };

  warns: Db['warns'] = {
    add: async (input) => {
      const [row] = await this.d.insert(s.warns).values(input).returning();
      return row!;
    },
    list: async (guildId, userId) =>
      this.d.select().from(s.warns).where(and(eq(s.warns.guildId, guildId), eq(s.warns.userId, userId))),
    setActive: async (id, active) => {
      const [row] = await this.d.update(s.warns).set({ active }).where(eq(s.warns.id, id)).returning();
      return !!row;
    },
    countActive: async (guildId, userId) => {
      const [row] = await this.d
        .select({ n: count() })
        .from(s.warns)
        .where(and(eq(s.warns.guildId, guildId), eq(s.warns.userId, userId), eq(s.warns.active, true)));
      return row?.n ?? 0;
    },
  };
}
