import { PermissionDeniedError } from '../core/errors.js';
import type { StaffRole } from '../db/types.js';
import type { AppContext } from './context.js';

export type Perm =
  | 'products.manage'
  | 'inventory.manage'
  | 'orders.view'
  | 'orders.manage'
  | 'payments.confirm'
  | 'payments.refund'
  | 'coupons.manage'
  | 'feedback.manage'
  | 'tickets.manage'
  | 'staff.manage'
  | 'config.manage'
  | 'audit.view'
  | 'mod.use'
  | 'stats.view';

export const ALL_PERMS: Perm[] = [
  'products.manage',
  'inventory.manage',
  'orders.view',
  'orders.manage',
  'payments.confirm',
  'payments.refund',
  'coupons.manage',
  'feedback.manage',
  'tickets.manage',
  'staff.manage',
  'config.manage',
  'audit.view',
  'mod.use',
  'stats.view',
];

export const ROLE_RANK: Record<StaffRole, number> = {
  OWNER: 100,
  ADMINISTRATOR: 80,
  FINANCE: 60,
  PRODUCT_MANAGER: 50,
  SUPPORT: 40,
  MODERATOR: 30,
};

const ADMIN_PERMS = ALL_PERMS.filter((p) => p !== 'payments.refund');

export const ROLE_PERMS: Record<StaffRole, Perm[]> = {
  OWNER: ALL_PERMS,
  ADMINISTRATOR: ADMIN_PERMS,
  FINANCE: ['orders.view', 'orders.manage', 'payments.confirm', 'payments.refund', 'tickets.manage', 'audit.view', 'stats.view'],
  PRODUCT_MANAGER: ['products.manage', 'inventory.manage', 'orders.view', 'stats.view'],
  SUPPORT: ['tickets.manage', 'orders.view', 'feedback.manage'],
  MODERATOR: ['mod.use'],
};

export interface ResolvedStaff {
  role: StaffRole;
  source: 'staff_table' | 'bootstrap_env';
}

export async function resolveStaff(ctx: AppContext, guildId: string, userId: string): Promise<ResolvedStaff | null> {
  const row = await ctx.db.staff.get(guildId, userId);
  if (row) return { role: row.role, source: 'staff_table' };
  if (ctx.env.BOOTSTRAP_OWNER_IDS.includes(userId)) return { role: 'OWNER', source: 'bootstrap_env' };
  return null;
}

export function roleCan(role: StaffRole, perm: Perm): boolean {
  return ROLE_PERMS[role].includes(perm);
}

export async function assertPerm(ctx: AppContext, guildId: string, userId: string, perm: Perm): Promise<ResolvedStaff> {
  const staff = await resolveStaff(ctx, guildId, userId);
  if (!staff || !roleCan(staff.role, perm)) throw new PermissionDeniedError();
  return staff;
}

/** Actor may grant/revoke roles strictly below their own rank. */
export function canManageRole(actor: StaffRole, target: StaffRole): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}
