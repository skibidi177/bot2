import type { GuildSettings } from '../services/guild-settings.js';
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

export interface OrderInsert {
  guildId: string;
  buyerId: string;
  subtotal: number;
  discount: number;
  total: number;
  couponId: number | null;
  paymentTransferCode: string;
  paymentProvider: string;
  paymentExpiresAt: Date;
  note?: string | null;
}

export interface OrderItemInsert {
  productId: number | null;
  variantId: number | null;
  productName: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface TransitionMeta {
  reason?: string | null;
  actorType: 'system' | 'staff' | 'provider' | 'user';
  actorId?: string | null;
  paidAt?: Date | null;
  completedAt?: Date | null;
  cancelReason?: string | null;
  paymentRef?: string | null;
}

export interface ProductFilter {
  categoryId?: number;
  activeOnly?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface OrderFilter {
  guildId?: string;
  status?: OrderStatus;
  buyerId?: string;
  limit?: number;
  offset?: number;
}

export interface FeedbackFilter {
  guildId?: string;
  status?: 'VISIBLE' | 'HIDDEN';
  limit?: number;
  offset?: number;
}

export interface AuditFilter {
  guildId?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

export interface AuditEntry {
  guildId?: string | null;
  actorType: 'system' | 'staff' | 'provider' | 'user';
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Storage facade. Two implementations exist: Drizzle (PostgreSQL, production)
 * and Memory (tests / local demo only). All state-mutating multi-step
 * operations run inside `tx` so both implementations provide atomicity
 * (memory: serialized + snapshot rollback, postgres: real transactions).
 */
export interface Db {
  readonly kind: 'postgres' | 'memory';
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;

  users: {
    upsert(input: { id: string; username: string; globalName?: string | null }): Promise<UserRow>;
    get(id: string): Promise<UserRow | null>;
    getByReferralCode(code: string): Promise<UserRow | null>;
    setReferralCode(id: string, code: string): Promise<void>;
    addLoyaltyCache(id: string, delta: number): Promise<void>;
  };
  categories: {
    list(opts?: { activeOnly?: boolean }): Promise<CategoryRow[]>;
    get(idOrSlug: number | string): Promise<CategoryRow | null>;
    create(input: { slug: string; name: string; description?: string | null; position?: number }): Promise<CategoryRow>;
    update(id: number, patch: Partial<Pick<CategoryRow, 'name' | 'description' | 'position' | 'active'>>): Promise<CategoryRow | null>;
  };
  products: {
    list(filter?: ProductFilter): Promise<ProductRow[]>;
    get(id: number): Promise<ProductRow | null>;
    getBySku(sku: string): Promise<ProductRow | null>;
    create(input: {
      sku: string;
      categoryId: number | null;
      name: string;
      description?: string;
      price: number;
      imageUrl?: string | null;
      deliveryMode?: 'AUTO' | 'MANUAL';
      stockTracked?: boolean;
      lowStockThreshold?: number;
    }): Promise<ProductRow>;
    update(
      id: number,
      patch: Partial<
        Pick<ProductRow, 'name' | 'description' | 'price' | 'imageUrl' | 'active' | 'categoryId' | 'deliveryMode' | 'stockTracked' | 'lowStockThreshold'>
      >,
    ): Promise<ProductRow | null>;
    softDelete(id: number): Promise<boolean>;
    variants(productId: number): Promise<VariantRow[]>;
    addVariant(input: { productId: number; name: string; priceDelta?: number }): Promise<VariantRow>;
  };
  inventory: {
    add(items: { productId: number; variantId?: number | null; ciphertext: string; batch?: string | null }[]): Promise<number>;
    /** Reserve `qty` AVAILABLE items atomically; throws OutOfStockError when short. Returns reserved item ids. */
    reserve(productId: number, variantId: number | null, qty: number, orderId: number): Promise<number[]>;
    releaseForOrder(orderId: number): Promise<number>;
    sellForOrder(orderId: number): Promise<number>;
    restockForOrder(orderId: number): Promise<number>;
    ciphertextsForOrder(orderId: number): Promise<InventoryRow[]>;
    availableCount(productId: number, variantId?: number | null): Promise<number>;
    countsByProduct(productIds: number[]): Promise<Map<number, number>>;
    list(filter: { productId?: number; status?: InventoryRow['status']; limit?: number; offset?: number }): Promise<InventoryRow[]>;
    markDefective(ids: number[]): Promise<number>;
  };
  orders: {
    insert(input: OrderInsert, items: OrderItemInsert[]): Promise<OrderRow>;
    get(id: number): Promise<OrderRow | null>;
    getByCode(code: number): Promise<OrderRow | null>;
    list(filter?: OrderFilter): Promise<OrderRow[]>;
    items(orderId: number): Promise<OrderItemRow[]>;
    /** Conditional status change: only applies when current status === from (null = any). Returns success. */
    transition(orderId: number, from: OrderStatus | null, to: OrderStatus, meta: TransitionMeta): Promise<boolean>;
    /** Fills bank transfer code / provider ref right after insert (code comes from a DB sequence). */
    setPaymentDetails(orderId: number, patch: { paymentTransferCode?: string; paymentRef?: string | null }): Promise<void>;
    history(orderId: number): Promise<OrderHistoryRow[]>;
    expirable(now: Date, limit?: number): Promise<OrderRow[]>;
    countByStatus(guildId: string): Promise<Record<string, number>>;
    revenueSince(guildId: string, since: Date): Promise<{ count: number; total: number }>;
  };
  payments: {
    insertEvent(input: {
      provider: string;
      providerEventId: string;
      orderCode: number | null;
      payload: Record<string, unknown>;
      signatureStatus: 'valid' | 'invalid' | 'none';
    }): Promise<{ status: 'inserted' | 'duplicate'; row: PaymentEventRow }>;
    markEventProcessed(id: number): Promise<void>;
    createTransaction(input: {
      orderId: number;
      provider: string;
      providerRef: string;
      amount: number;
      expectedAmount: number;
      status: 'success' | 'amount_mismatch' | 'refunded';
      verifiedBy: 'provider_webhook' | 'staff';
      verifierId?: string | null;
      counterAccount?: string | null;
      counterAccountName?: string | null;
      paidAt?: Date | null;
    }): Promise<'created' | 'duplicate'>;
    getByOrder(orderId: number): Promise<PaymentTxRow | null>;
  };
  coupons: {
    get(code: string): Promise<CouponRow | null>;
    getById(id: number): Promise<CouponRow | null>;
    list(limit?: number): Promise<CouponRow[]>;
    create(input: {
      code: string;
      kind: 'percent' | 'fixed';
      value: number;
      maxUses?: number | null;
      perUserLimit?: number;
      minOrder?: number;
      startsAt?: Date | null;
      expiresAt?: Date | null;
      createdBy?: string | null;
    }): Promise<CouponRow>;
    update(id: number, patch: Partial<Pick<CouponRow, 'active' | 'maxUses' | 'expiresAt'>>): Promise<CouponRow | null>;
    redeem(couponId: number, orderId: number, userId: string): Promise<'ok' | 'limit_user' | 'limit_total'>;
    uses(couponId: number): Promise<number>;
    userUses(couponId: number, userId: string): Promise<number>;
  };
  feedback: {
    create(input: { orderId: number; guildId: string; authorId: string; rating: number; content: string }): Promise<FeedbackRow>;
    getByOrder(orderId: number): Promise<FeedbackRow | null>;
    list(filter?: FeedbackFilter): Promise<FeedbackRow[]>;
    update(id: number, patch: Partial<Pick<FeedbackRow, 'status' | 'hiddenReason' | 'shopReply' | 'messageUrl'>>): Promise<FeedbackRow | null>;
    stats(guildId: string): Promise<{ count: number; average: number; completedOrders: number }>;
  };
  tickets: {
    create(input: { code: string; guildId: string; openerId: string; subject: string; channelId?: string | null; orderId?: number | null }): Promise<TicketRow>;
    getByCode(code: string): Promise<TicketRow | null>;
    getById(id: number): Promise<TicketRow | null>;
    list(filter: { guildId?: string; status?: TicketRow['status']; limit?: number; offset?: number }): Promise<TicketRow[]>;
    update(id: number, patch: Partial<Pick<TicketRow, 'status' | 'channelId' | 'closedAt'>>): Promise<TicketRow | null>;
  };
  audit: {
    log(entry: AuditEntry): Promise<void>;
    list(filter?: AuditFilter): Promise<AuditRow[]>;
  };
  loyalty: {
    add(userId: string, delta: number, reason: string, orderId?: number | null): Promise<void>;
    entries(userId: string, limit?: number): Promise<LoyaltyRow[]>;
  };
  referrals: {
    link(referrerId: string, referredId: string): Promise<'ok' | 'self' | 'exists'>;
    getByReferred(id: string): Promise<ReferralRow | null>;
    markRewarded(id: number): Promise<void>;
    countByReferrer(id: string): Promise<number>;
  };
  staff: {
    get(guildId: string, discordId: string): Promise<StaffRow | null>;
    list(guildId: string): Promise<StaffRow[]>;
    listForUser(discordId: string): Promise<StaffRow[]>;
    grant(guildId: string, discordId: string, role: StaffRole, grantedBy: string | null): Promise<StaffRow>;
    revoke(guildId: string, discordId: string): Promise<boolean>;
  };
  guildConfig: {
    get(guildId: string): Promise<GuildSettings>;
    set(guildId: string, settings: GuildSettings): Promise<void>;
    listGuilds(): Promise<string[]>;
  };
  warns: {
    add(input: { guildId: string; userId: string; moderatorId: string; reason: string }): Promise<WarnRow>;
    list(guildId: string, userId: string): Promise<WarnRow[]>;
    setActive(id: number, active: boolean): Promise<boolean>;
    countActive(guildId: string, userId: string): Promise<number>;
  };
}
