import { describe, expect, it } from 'vitest';
import { CouponError } from '../../src/core/errors.js';
import type { CouponRow } from '../../src/db/types.js';
import { discountFor, subtotalOf, validateCoupon, type CartLine } from '../../src/services/pricing.js';

const lines: CartLine[] = [
  { productId: 1, variantId: null, name: 'A', unitPrice: 30000, quantity: 2 },
  { productId: 2, variantId: null, name: 'B', unitPrice: 10000, quantity: 1 },
];

function coupon(patch: Partial<CouponRow> = {}): CouponRow {
  return {
    id: 1,
    code: 'SALE',
    kind: 'percent',
    value: 10,
    maxUses: null,
    perUserLimit: 1,
    minOrder: 0,
    startsAt: null,
    expiresAt: null,
    active: true,
    createdBy: null,
    createdAt: new Date(),
    ...patch,
  };
}

const now = new Date('2026-01-15T00:00:00Z');

describe('pricing', () => {
  it('computes subtotal', () => {
    expect(subtotalOf(lines)).toBe(70000);
  });

  it('percent discount floors to integer vnd', () => {
    expect(discountFor(coupon({ value: 15 }), 70000)).toBe(10500);
    expect(discountFor(coupon({ value: 33 }), 1000)).toBe(330);
  });

  it('fixed discount caps at subtotal', () => {
    expect(discountFor(coupon({ kind: 'fixed', value: 999999 }), 70000)).toBe(70000);
  });

  it('validates coupon lifecycle', () => {
    expect(() => validateCoupon(coupon({ active: false }), { subtotal: 70000, now, totalUses: 0, userUses: 0 })).toThrow(CouponError);
    expect(() => validateCoupon(coupon({ expiresAt: new Date('2026-01-01') }), { subtotal: 70000, now, totalUses: 0, userUses: 0 })).toThrow(/hết hạn/);
    expect(() => validateCoupon(coupon({ startsAt: new Date('2026-02-01') }), { subtotal: 70000, now, totalUses: 0, userUses: 0 })).toThrow(/hiệu lực/);
    expect(() => validateCoupon(coupon({ minOrder: 100000 }), { subtotal: 70000, now, totalUses: 0, userUses: 0 })).toThrow(/tối thiểu/);
    expect(() => validateCoupon(coupon({ maxUses: 5 }), { subtotal: 70000, now, totalUses: 5, userUses: 0 })).toThrow(/hết lượt/);
    expect(() => validateCoupon(coupon(), { subtotal: 70000, now, totalUses: 0, userUses: 1 })).toThrow(/dùng mã/);
    validateCoupon(coupon(), { subtotal: 70000, now, totalUses: 0, userUses: 0 });
  });
});
