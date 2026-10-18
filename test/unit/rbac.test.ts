import { describe, expect, it } from 'vitest';
import { canManageRole, roleCan } from '../../src/services/rbac.js';

describe('rbac matrix', () => {
  it('owner can do everything, moderator only moderation', () => {
    expect(roleCan('OWNER', 'payments.refund')).toBe(true);
    expect(roleCan('OWNER', 'staff.manage')).toBe(true);
    expect(roleCan('MODERATOR', 'mod.use')).toBe(true);
    expect(roleCan('MODERATOR', 'orders.view')).toBe(false);
  });

  it('refund is a segregated finance/owner permission', () => {
    expect(roleCan('ADMINISTRATOR', 'payments.refund')).toBe(false);
    expect(roleCan('FINANCE', 'payments.refund')).toBe(true);
    expect(roleCan('FINANCE', 'payments.confirm')).toBe(true);
    expect(roleCan('SUPPORT', 'payments.confirm')).toBe(false);
  });

  it('product manager cannot touch payments', () => {
    expect(roleCan('PRODUCT_MANAGER', 'inventory.manage')).toBe(true);
    expect(roleCan('PRODUCT_MANAGER', 'payments.confirm')).toBe(false);
  });

  it('rank rules prevent privilege escalation', () => {
    expect(canManageRole('OWNER', 'ADMINISTRATOR')).toBe(true);
    expect(canManageRole('ADMINISTRATOR', 'ADMINISTRATOR')).toBe(false);
    expect(canManageRole('ADMINISTRATOR', 'OWNER')).toBe(false);
    expect(canManageRole('SUPPORT', 'MODERATOR')).toBe(true);
    expect(canManageRole('MODERATOR', 'SUPPORT')).toBe(false);
  });
});
