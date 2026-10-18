import { OutOfStockError } from '../core/errors.js';
import { parseGuildSettings, type GuildSettings } from '../services/guild-settings.js';
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
import type {
  AuditRow,
  CategoryRow,
  CouponRow,
  FeedbackRow,
  InventoryRow,
  LoyaltyRow,
  OrderHistoryRow,
  OrderItemRow,
  OrderRow,
  OrderStatus,
  PaymentEventRow,
  PaymentTxRow,
  ProductRow,
  ReferralRow,
  StaffRole,
  StaffRow,
  TicketRow,
  UserRow,
  VariantRow,
  WarnRow,
} from './types.js';

interface Store {
  seq: Record<string, number>;
  users: UserRow[];
  categories: CategoryRow[];
  products: ProductRow[];
  variants: VariantRow[];
  inventory: InventoryRow[];
  orders: OrderRow[];
  orderItems: OrderItemRow[];
  orderHistory: OrderHistoryRow[];
  paymentEvents: PaymentEventRow[];
  paymentTx: PaymentTxRow[];
  coupons: CouponRow[];
  redemptions: { id: number; couponId: number; orderId: number; userId: string; createdAt: Date }[];
  feedbacks: FeedbackRow[];
  tickets: TicketRow[];
  audit: AuditRow[];
  loyalty: LoyaltyRow[];
  referrals: ReferralRow[];
  staff: StaffRow[];
  guildConfigs: Record<string, GuildSettings>;
  warns: WarnRow[];
}

function emptyStore(): Store {
  return {
    seq: { orderCode: 100001 },
    users: [],
    categories: [],
    products: [],
    variants: [],
    inventory: [],
    orders: [],
    orderItems: [],
    orderHistory: [],
    paymentEvents: [],
    paymentTx: [],
    coupons: [],
    redemptions: [],
    feedbacks: [],
    tickets: [],
    audit: [],
    loyalty: [],
    referrals: [],
    staff: [],
    guildConfigs: {},
    warns: [],
  };
}

const now = () => new Date();

/**
 * In-memory Db implementation for tests and local demos.
 * Transactions serialize through a mutex and roll back via snapshot restore,
 * which reproduces the atomicity guarantees the Postgres implementation gets
 * from real transactions (including conditional status transitions).
 */
export class MemoryDb implements Db {
  readonly kind = 'memory' as const;
  private store: Store = emptyStore();
  private mutex: Promise<unknown> = Promise.resolve();
  private idc: Record<string, number> = {};

  constructor(opts?: { startOrderCode?: number }) {
    if (opts?.startOrderCode) this.store.seq.orderCode = opts.startOrderCode;
  }

  private nextId(table: string): number {
    this.idc[table] = (this.idc[table] ?? 0) + 1;
    return this.idc[table];
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const run = this.mutex.then(async () => {
      const snapshot = structuredClone(this.store);
      try {
        return await fn(this);
      } catch (err) {
        this.store = snapshot;
        throw err;
      }
    });
    this.mutex = run.catch(() => undefined);
    return run;
  }

  /** Test helper: advance time-based queries by mutating timestamps. */
  _setOrderExpiry(code: number, date: Date): void {
    const o = this.store.orders.find((x) => x.code === code);
    if (o) o.paymentExpiresAt = date;
  }
  _store(): Store {
    return this.store;
  }

  users: Db['users'] = {
    upsert: async (input) => {
      let u = this.store.users.find((x) => x.id === input.id);
      if (!u) {
        u = {
          id: input.id,
          username: input.username,
          globalName: input.globalName ?? null,
          referralCode: null,
          loyaltyPoints: 0,
          createdAt: now(),
          updatedAt: now(),
        };
        this.store.users.push(u);
      } else {
        u.username = input.username;
        u.globalName = input.globalName ?? u.globalName;
        u.updatedAt = now();
      }
      return { ...u };
    },
    get: async (id) => {
      const u = this.store.users.find((x) => x.id === id);
      return u ? { ...u } : null;
    },
    getByReferralCode: async (code) => {
      const u = this.store.users.find((x) => x.referralCode === code);
      return u ? { ...u } : null;
    },
    setReferralCode: async (id, code) => {
      const u = this.store.users.find((x) => x.id === id);
      if (u) u.referralCode = code;
    },
    addLoyaltyCache: async (id, delta) => {
      const u = this.store.users.find((x) => x.id === id);
      if (u) u.loyaltyPoints += delta;
    },
  };

  categories: Db['categories'] = {
    list: async (opts) =>
      this.store.categories
        .filter((c) => (opts?.activeOnly ? c.active : true))
        .sort((a, b) => a.position - b.position)
        .map((c) => ({ ...c })),
    get: async (idOrSlug) => {
      const c =
        typeof idOrSlug === 'number'
          ? this.store.categories.find((x) => x.id === idOrSlug)
          : this.store.categories.find((x) => x.slug === idOrSlug);
      return c ? { ...c } : null;
    },
    create: async (input) => {
      const row: CategoryRow = {
        id: this.nextId('categories'),
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        position: input.position ?? 0,
        active: true,
        createdAt: now(),
      };
      this.store.categories.push(row);
      return { ...row };
    },
    update: async (id, patch) => {
      const c = this.store.categories.find((x) => x.id === id);
      if (!c) return null;
      Object.assign(c, patch);
      return { ...c };
    },
  };

  products: Db['products'] = {
    list: async (filter: ProductFilter = {}) => {
      let rows = this.store.products.filter((p) => !p.deletedAt);
      if (filter.activeOnly) rows = rows.filter((p) => p.active);
      if (filter.categoryId !== undefined) rows = rows.filter((p) => p.categoryId === filter.categoryId);
      if (filter.search) {
        const q = filter.search.toLowerCase();
        rows = rows.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
      }
      rows = rows.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50));
      return rows.map((p) => ({ ...p }));
    },
    get: async (id) => {
      const p = this.store.products.find((x) => x.id === id && !x.deletedAt);
      return p ? { ...p } : null;
    },
    getBySku: async (sku) => {
      const p = this.store.products.find((x) => x.sku === sku && !x.deletedAt);
      return p ? { ...p } : null;
    },
    create: async (input) => {
      const row: ProductRow = {
        id: this.nextId('products'),
        sku: input.sku,
        categoryId: input.categoryId ?? null,
        name: input.name,
        description: input.description ?? '',
        price: input.price,
        imageUrl: input.imageUrl ?? null,
        deliveryMode: input.deliveryMode ?? 'AUTO',
        stockTracked: input.stockTracked ?? true,
        lowStockThreshold: input.lowStockThreshold ?? 5,
        active: true,
        deletedAt: null,
        metadata: {},
        createdAt: now(),
        updatedAt: now(),
      };
      this.store.products.push(row);
      return { ...row };
    },
    update: async (id, patch) => {
      const p = this.store.products.find((x) => x.id === id && !x.deletedAt);
      if (!p) return null;
      Object.assign(p, patch, { updatedAt: now() });
      return { ...p };
    },
    softDelete: async (id) => {
      const p = this.store.products.find((x) => x.id === id && !x.deletedAt);
      if (!p) return false;
      p.deletedAt = now();
      return true;
    },
    variants: async (productId) => this.store.variants.filter((v) => v.productId === productId).map((v) => ({ ...v })),
    addVariant: async (input) => {
      const row: VariantRow = {
        id: this.nextId('variants'),
        productId: input.productId,
        name: input.name,
        priceDelta: input.priceDelta ?? 0,
        active: true,
      };
      this.store.variants.push(row);
      return { ...row };
    },
  };

  inventory: Db['inventory'] = {
    add: async (items) => {
      for (const it of items) {
        this.store.inventory.push({
          id: this.nextId('inventory'),
          productId: it.productId,
          variantId: it.variantId ?? null,
          secretCiphertext: it.ciphertext,
          status: 'AVAILABLE',
          orderId: null,
          batch: it.batch ?? null,
          createdAt: now(),
          updatedAt: now(),
        });
      }
      return items.length;
    },
    reserve: async (productId, variantId, qty, orderId) => {
      const available = this.store.inventory.filter(
        (i) => i.productId === productId && i.variantId === (variantId ?? null) && i.status === 'AVAILABLE',
      );
      if (available.length < qty) {
        const p = this.store.products.find((x) => x.id === productId);
        throw new OutOfStockError([p?.name ?? `product#${productId}`]);
      }
      const ids: number[] = [];
      for (let i = 0; i < qty; i++) {
        const item = available[i]!;
        item.status = 'RESERVED';
        item.orderId = orderId;
        item.updatedAt = now();
        ids.push(item.id);
      }
      return ids;
    },
    releaseForOrder: async (orderId) => {
      let n = 0;
      for (const i of this.store.inventory) {
        if (i.orderId === orderId && i.status === 'RESERVED') {
          i.status = 'AVAILABLE';
          i.orderId = null;
          i.updatedAt = now();
          n++;
        }
      }
      return n;
    },
    sellForOrder: async (orderId) => {
      let n = 0;
      for (const i of this.store.inventory) {
        if (i.orderId === orderId && i.status === 'RESERVED') {
          i.status = 'SOLD';
          i.updatedAt = now();
          n++;
        }
      }
      return n;
    },
    restockForOrder: async (orderId) => {
      let n = 0;
      for (const i of this.store.inventory) {
        if (i.orderId === orderId && i.status === 'SOLD') {
          i.status = 'AVAILABLE';
          i.orderId = null;
          i.updatedAt = now();
          n++;
        }
      }
      return n;
    },
    ciphertextsForOrder: async (orderId) =>
      this.store.inventory
        .filter((i) => i.orderId === orderId && (i.status === 'SOLD' || i.status === 'RESERVED'))
        .map((i) => ({ ...i })),
    availableCount: async (productId, variantId) =>
      this.store.inventory.filter(
        (i) => i.productId === productId && i.variantId === (variantId ?? null) && i.status === 'AVAILABLE',
      ).length,
    countsByProduct: async (productIds) => {
      const m = new Map<number, number>();
      for (const id of productIds) m.set(id, await this.inventory.availableCount(id));
      return m;
    },
    list: async (filter) => {
      let rows = this.store.inventory;
      if (filter.productId !== undefined) rows = rows.filter((i) => i.productId === filter.productId);
      if (filter.status) rows = rows.filter((i) => i.status === filter.status);
      return rows.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 100)).map((i) => ({ ...i }));
    },
    markDefective: async (ids) => {
      let n = 0;
      for (const i of this.store.inventory) {
        if (ids.includes(i.id) && i.status === 'AVAILABLE') {
          i.status = 'DEFECTIVE';
          i.updatedAt = now();
          n++;
        }
      }
      return n;
    },
  };

  orders: Db['orders'] = {
    insert: async (input: OrderInsert, items: OrderItemInsert[]) => {
      const code = this.store.seq.orderCode++;
      const row: OrderRow = {
        id: this.nextId('orders'),
        code,
        guildId: input.guildId,
        buyerId: input.buyerId,
        status: 'PENDING_PAYMENT',
        subtotal: input.subtotal,
        discount: input.discount,
        total: input.total,
        couponId: input.couponId,
        paymentTransferCode: input.paymentTransferCode,
        paymentProvider: input.paymentProvider,
        paymentRef: null,
        paymentExpiresAt: input.paymentExpiresAt,
        paidAt: null,
        completedAt: null,
        cancelReason: null,
        note: input.note ?? null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.store.orders.push(row);
      for (const it of items) {
        this.store.orderItems.push({ id: this.nextId('orderItems'), orderId: row.id, ...it });
      }
      this.store.orderHistory.push({
        id: this.nextId('orderHistory'),
        orderId: row.id,
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
        reason: 'order created',
        actorType: 'system',
        actorId: input.buyerId,
        createdAt: now(),
      });
      return { ...row };
    },
    get: async (id) => {
      const o = this.store.orders.find((x) => x.id === id);
      return o ? { ...o } : null;
    },
    getByCode: async (code) => {
      const o = this.store.orders.find((x) => x.code === code);
      return o ? { ...o } : null;
    },
    list: async (filter: OrderFilter = {}) => {
      let rows = [...this.store.orders];
      if (filter.guildId) rows = rows.filter((o) => o.guildId === filter.guildId);
      if (filter.status) rows = rows.filter((o) => o.status === filter.status);
      if (filter.buyerId) rows = rows.filter((o) => o.buyerId === filter.buyerId);
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50)).map((o) => ({ ...o }));
    },
    items: async (orderId) => this.store.orderItems.filter((i) => i.orderId === orderId).map((i) => ({ ...i })),
    transition: async (orderId, from, to, meta: TransitionMeta) => {
      const o = this.store.orders.find((x) => x.id === orderId);
      if (!o) return false;
      if (from !== null && o.status !== from) return false;
      const prev = o.status;
      o.status = to;
      o.updatedAt = now();
      if (meta.paidAt) o.paidAt = meta.paidAt;
      else if (to === 'PAID') o.paidAt = now();
      if (meta.completedAt) o.completedAt = meta.completedAt;
      else if (to === 'COMPLETED') o.completedAt = now();
      if (meta.cancelReason !== undefined) o.cancelReason = meta.cancelReason;
      if (meta.paymentRef !== undefined && meta.paymentRef !== null) o.paymentRef = meta.paymentRef;
      this.store.orderHistory.push({
        id: this.nextId('orderHistory'),
        orderId,
        fromStatus: prev,
        toStatus: to,
        reason: meta.reason ?? null,
        actorType: meta.actorType,
        actorId: meta.actorId ?? null,
        createdAt: now(),
      });
      return true;
    },
    setPaymentDetails: async (orderId, patch) => {
      const o = this.store.orders.find((x) => x.id === orderId);
      if (!o) return;
      if (patch.paymentTransferCode !== undefined) o.paymentTransferCode = patch.paymentTransferCode;
      if (patch.paymentRef !== undefined) o.paymentRef = patch.paymentRef;
      o.updatedAt = now();
    },
    history: async (orderId) =>
      this.store.orderHistory
        .filter((h) => h.orderId === orderId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((h) => ({ ...h })),
    expirable: async (cutoff, limit = 100) =>
      this.store.orders
        .filter((o) => o.status === 'PENDING_PAYMENT' && o.paymentExpiresAt <= cutoff)
        .slice(0, limit)
        .map((o) => ({ ...o })),
    countByStatus: async (guildId) => {
      const out: Record<string, number> = {};
      for (const o of this.store.orders.filter((x) => x.guildId === guildId)) {
        out[o.status] = (out[o.status] ?? 0) + 1;
      }
      return out;
    },
    revenueSince: async (guildId, since) => {
      const rows = this.store.orders.filter(
        (o) => o.guildId === guildId && ['PAID', 'PROCESSING', 'COMPLETED'].includes(o.status) && o.createdAt >= since,
      );
      return { count: rows.length, total: rows.reduce((s, o) => s + o.total, 0) };
    },
  };

  payments: Db['payments'] = {
    insertEvent: async (input) => {
      const existing = this.store.paymentEvents.find(
        (e) => e.provider === input.provider && e.providerEventId === input.providerEventId,
      );
      if (existing) return { status: 'duplicate', row: { ...existing } };
      const row: PaymentEventRow = {
        id: this.nextId('paymentEvents'),
        provider: input.provider,
        providerEventId: input.providerEventId,
        orderCode: input.orderCode,
        payload: input.payload,
        signatureStatus: input.signatureStatus,
        processed: false,
        receivedAt: now(),
      };
      this.store.paymentEvents.push(row);
      return { status: 'inserted', row: { ...row } };
    },
    markEventProcessed: async (id) => {
      const e = this.store.paymentEvents.find((x) => x.id === id);
      if (e) e.processed = true;
    },
    createTransaction: async (input) => {
      const dup = this.store.paymentTx.find(
        (t) => t.provider === input.provider && t.providerRef === input.providerRef,
      );
      if (dup) return 'duplicate';
      this.store.paymentTx.push({
        id: this.nextId('paymentTx'),
        orderId: input.orderId,
        provider: input.provider,
        providerRef: input.providerRef,
        amount: input.amount,
        expectedAmount: input.expectedAmount,
        status: input.status,
        verifiedBy: input.verifiedBy,
        verifierId: input.verifierId ?? null,
        counterAccount: input.counterAccount ?? null,
        counterAccountName: input.counterAccountName ?? null,
        paidAt: input.paidAt ?? now(),
        createdAt: now(),
      });
      return 'created';
    },
    getByOrder: async (orderId) => {
      const t = this.store.paymentTx.find((x) => x.orderId === orderId);
      return t ? { ...t } : null;
    },
  };

  coupons: Db['coupons'] = {
    get: async (code) => {
      const c = this.store.coupons.find((x) => x.code === code.toUpperCase());
      return c ? { ...c } : null;
    },
    getById: async (id) => {
      const c = this.store.coupons.find((x) => x.id === id);
      return c ? { ...c } : null;
    },
    list: async (limit = 50) => this.store.coupons.slice(0, limit).map((c) => ({ ...c })),
    create: async (input) => {
      const row: CouponRow = {
        id: this.nextId('coupons'),
        code: input.code.toUpperCase(),
        kind: input.kind,
        value: input.value,
        maxUses: input.maxUses ?? null,
        perUserLimit: input.perUserLimit ?? 1,
        minOrder: input.minOrder ?? 0,
        startsAt: input.startsAt ?? null,
        expiresAt: input.expiresAt ?? null,
        active: true,
        createdBy: input.createdBy ?? null,
        createdAt: now(),
      };
      this.store.coupons.push(row);
      return { ...row };
    },
    update: async (id, patch) => {
      const c = this.store.coupons.find((x) => x.id === id);
      if (!c) return null;
      Object.assign(c, patch);
      return { ...c };
    },
    redeem: async (couponId, orderId, userId) => {
      const coupon = this.store.coupons.find((c) => c.id === couponId);
      if (!coupon) return 'limit_total';
      const total = this.store.redemptions.filter((r) => r.couponId === couponId).length;
      if (coupon.maxUses !== null && total >= coupon.maxUses) return 'limit_total';
      const perUser = this.store.redemptions.filter((r) => r.couponId === couponId && r.userId === userId).length;
      if (perUser >= coupon.perUserLimit) return 'limit_user';
      this.store.redemptions.push({ id: this.nextId('redemptions'), couponId, orderId, userId, createdAt: now() });
      return 'ok';
    },
    uses: async (couponId) => this.store.redemptions.filter((r) => r.couponId === couponId).length,
    userUses: async (couponId, userId) =>
      this.store.redemptions.filter((r) => r.couponId === couponId && r.userId === userId).length,
  };

  feedback: Db['feedback'] = {
    create: async (input) => {
      if (this.store.feedbacks.some((f) => f.orderId === input.orderId)) {
        throw new Error('FEEDBACK_EXISTS');
      }
      const row: FeedbackRow = {
        id: this.nextId('feedbacks'),
        orderId: input.orderId,
        guildId: input.guildId,
        authorId: input.authorId,
        rating: input.rating,
        content: input.content,
        status: 'VISIBLE',
        hiddenReason: null,
        shopReply: null,
        messageUrl: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.store.feedbacks.push(row);
      return { ...row };
    },
    getByOrder: async (orderId) => {
      const f = this.store.feedbacks.find((x) => x.orderId === orderId);
      return f ? { ...f } : null;
    },
    list: async (filter: FeedbackFilter = {}) => {
      let rows = [...this.store.feedbacks];
      if (filter.guildId) rows = rows.filter((f) => f.guildId === filter.guildId);
      if (filter.status) rows = rows.filter((f) => f.status === filter.status);
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50)).map((f) => ({ ...f }));
    },
    update: async (id, patch) => {
      const f = this.store.feedbacks.find((x) => x.id === id);
      if (!f) return null;
      Object.assign(f, patch, { updatedAt: now() });
      return { ...f };
    },
    stats: async (guildId) => {
      const visible = this.store.feedbacks.filter((f) => f.guildId === guildId && f.status === 'VISIBLE');
      const completed = this.store.orders.filter((o) => o.guildId === guildId && o.status === 'COMPLETED').length;
      const average = visible.length ? visible.reduce((s, f) => s + f.rating, 0) / visible.length : 0;
      return { count: visible.length, average: Math.round(average * 100) / 100, completedOrders: completed };
    },
  };

  tickets: Db['tickets'] = {
    create: async (input) => {
      const row: TicketRow = {
        id: this.nextId('tickets'),
        code: input.code,
        guildId: input.guildId,
        openerId: input.openerId,
        subject: input.subject,
        status: 'OPEN',
        channelId: input.channelId ?? null,
        orderId: input.orderId ?? null,
        createdAt: now(),
        closedAt: null,
      };
      this.store.tickets.push(row);
      return { ...row };
    },
    getByCode: async (code) => {
      const t = this.store.tickets.find((x) => x.code === code);
      return t ? { ...t } : null;
    },
    getById: async (id) => {
      const t = this.store.tickets.find((x) => x.id === id);
      return t ? { ...t } : null;
    },
    list: async (filter) => {
      let rows = [...this.store.tickets];
      if (filter.guildId) rows = rows.filter((t) => t.guildId === filter.guildId);
      if (filter.status) rows = rows.filter((t) => t.status === filter.status);
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50)).map((t) => ({ ...t }));
    },
    update: async (id, patch) => {
      const t = this.store.tickets.find((x) => x.id === id);
      if (!t) return null;
      Object.assign(t, patch);
      return { ...t };
    },
  };

  audit: Db['audit'] = {
    log: async (entry: AuditEntry) => {
      this.store.audit.push({
        id: this.nextId('audit'),
        guildId: entry.guildId ?? null,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        detail: entry.detail ?? {},
        createdAt: now(),
      });
    },
    list: async (filter: AuditFilter = {}) => {
      let rows = [...this.store.audit];
      if (filter.guildId) rows = rows.filter((a) => a.guildId === filter.guildId);
      if (filter.action) rows = rows.filter((a) => a.action === filter.action);
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 100)).map((a) => ({ ...a }));
    },
  };

  loyalty: Db['loyalty'] = {
    add: async (userId, delta, reason, orderId) => {
      this.store.loyalty.push({
        id: this.nextId('loyalty'),
        userId,
        delta,
        reason,
        orderId: orderId ?? null,
        createdAt: now(),
      });
      await this.users.addLoyaltyCache(userId, delta);
    },
    entries: async (userId, limit = 50) =>
      this.store.loyalty
        .filter((l) => l.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((l) => ({ ...l })),
  };
  
  referrals: Db['referrals'] = {
    link: async (referrerId, referredId) => {
      if (referrerId === referredId) return 'self';
      if (this.store.referrals.some((r) => r.referredId === referredId)) return 'exists';
      if (this.store.referrals.some((r) => r.referrerId === referredId && r.referredId === referrerId)) return 'self';
      this.store.referrals.push({ id: this.nextId('referrals'), referrerId, referredId, rewardedAt: null, createdAt: now() });
      return 'ok';
    },
    getByReferred: async (id) => {
      const r = this.store.referrals.find((x) => x.referredId === id);
      return r ? { ...r } : null;
    },
    markRewarded: async (id) => {
      const r = this.store.referrals.find((x) => x.id === id);
      if (r) r.rewardedAt = now();
    },
    countByReferrer: async (id) => this.store.referrals.filter((r) => r.referrerId === id).length,
  };

  staff: Db['staff'] = {
    get: async (guildId, discordId) => {
      const s = this.store.staff.find((x) => x.guildId === guildId && x.discordId === discordId);
      return s ? { ...s } : null;
    },
    list: async (guildId) => this.store.staff.filter((s) => s.guildId === guildId).map((s) => ({ ...s })),
    listForUser: async (discordId) => this.store.staff.filter((s) => s.discordId === discordId).map((s) => ({ ...s })),
    grant: async (guildId, discordId, role: StaffRole, grantedBy) => {
      const existing = this.store.staff.find((x) => x.guildId === guildId && x.discordId === discordId);
      if (existing) {
        existing.role = role;
        return { ...existing };
      }
      const row: StaffRow = {
        id: this.nextId('staff'),
        guildId,
        discordId,
        role,
        grantedBy,
        createdAt: now(),
      };
      this.store.staff.push(row);
      return { ...row };
    },
    revoke: async (guildId, discordId) => {
      const idx = this.store.staff.findIndex((x) => x.guildId === guildId && x.discordId === discordId);
      if (idx === -1) return false;
      this.store.staff.splice(idx, 1);
      return true;
    },
  };

  guildConfig: Db['guildConfig'] = {
    get: async (guildId) => parseGuildSettings(this.store.guildConfigs[guildId] ?? {}),
    set: async (guildId, settings) => {
      this.store.guildConfigs[guildId] = settings;
    },
    listGuilds: async () => Object.keys(this.store.guildConfigs),
  };

  warns: Db['warns'] = {
    add: async (input) => {
      const row: WarnRow = { id: this.nextId('warns'), active: true, createdAt: now(), ...input };
      this.store.warns.push(row);
      return { ...row };
    },
    list: async (guildId, userId) =>
      this.store.warns.filter((w) => w.guildId === guildId && w.userId === userId).map((w) => ({ ...w })),
    setActive: async (id, active) => {
      const w = this.store.warns.find((x) => x.id === id);
      if (!w) return false;
      w.active = active;
      return true;
    },
    countActive: async (guildId, userId) =>
      this.store.warns.filter((w) => w.guildId === guildId && w.userId === userId && w.active).length,
  };
}

export type { OrderStatus };
