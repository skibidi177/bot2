import { CouponError } from '../core/errors.js';
import type { CouponRow } from '../db/types.js';

export interface CartLine {
  productId: number;
  variantId: number | null;
  name: string;
  unitPrice: number;
  quantity: number;
}

export function lineTotal(line: CartLine): number {
  return line.unitPrice * line.quantity;
}

export function subtotalOf(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + lineTotal(l), 0);
}

/** Validate a coupon for a given cart; throws CouponError with a user-facing message. */
export function validateCoupon(
  coupon: CouponRow,
  opts: { subtotal: number; now: Date; totalUses: number; userUses: number },
): void {
  if (!coupon.active) throw new CouponError('Mã giảm giá đã bị tắt');
  if (coupon.startsAt && opts.now < coupon.startsAt) throw new CouponError('Mã giảm giá chưa có hiệu lực');
  if (coupon.expiresAt && opts.now > coupon.expiresAt) throw new CouponError('Mã giảm giá đã hết hạn');
  if (coupon.minOrder > 0 && opts.subtotal < coupon.minOrder) {
    throw new CouponError(`Mã giảm giá yêu cầu đơn tối thiểu ${coupon.minOrder.toLocaleString('vi-VN')}₫`);
  }
  if (coupon.maxUses !== null && opts.totalUses >= coupon.maxUses) throw new CouponError('Mã giảm giá đã hết lượt dùng');
  if (opts.userUses >= coupon.perUserLimit) throw new CouponError('Bạn đã dùng mã giảm giá này rồi');
}

export function discountFor(coupon: CouponRow, subtotal: number): number {
  const raw = coupon.kind === 'percent' ? Math.floor((subtotal * coupon.value) / 100) : coupon.value;
  return Math.max(0, Math.min(raw, subtotal));
}

export function formatVnd(amount: number): string {
  return `${amount.toLocaleString('vi-VN')}₫`;
}
