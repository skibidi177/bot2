import type {
  auditLogs,
  categories,
  couponRedemptions,
  coupons,
  feedbacks,
  guildConfigs,
  inventoryItems,
  loyaltyLedger,
  orderItems,
  orderStatusHistory,
  orders,
  paymentEvents,
  paymentTransactions,
  productVariants,
  products,
  referrals,
  staffPermissions,
  tickets,
  users,
  warns,
} from './schema.js';

export type UserRow = typeof users.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type VariantRow = typeof productVariants.$inferSelect;
export type InventoryRow = typeof inventoryItems.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type OrderHistoryRow = typeof orderStatusHistory.$inferSelect;
export type PaymentEventRow = typeof paymentEvents.$inferSelect;
export type PaymentTxRow = typeof paymentTransactions.$inferSelect;
export type CouponRow = typeof coupons.$inferSelect;
export type CouponRedemptionRow = typeof couponRedemptions.$inferSelect;
export type FeedbackRow = typeof feedbacks.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
export type AuditRow = typeof auditLogs.$inferSelect;
export type LoyaltyRow = typeof loyaltyLedger.$inferSelect;
export type ReferralRow = typeof referrals.$inferSelect;
export type StaffRow = typeof staffPermissions.$inferSelect;
export type GuildConfigRow = typeof guildConfigs.$inferSelect;
export type WarnRow = typeof warns.$inferSelect;

export type OrderStatus = OrderRow['status'];
export type StaffRole = StaffRow['role'];
export type InventoryStatus = InventoryRow['status'];
