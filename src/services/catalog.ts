import { AppError, NotFoundError } from '../core/errors.js';
import { batchId } from '../core/ids.js';
import { parseCsv } from '../core/csv.js';
import type { AppContext } from './context.js';
import { assertPerm } from './rbac.js';

export async function addInventoryLines(
  ctx: AppContext,
  input: { guildId: string; actorId: string; productId: number; lines: string[] },
): Promise<{ added: number; batch: string }> {
  await assertPerm(ctx, input.guildId, input.actorId, 'inventory.manage');
  const product = await ctx.db.products.get(input.productId);
  if (!product) throw new NotFoundError('Không tìm thấy sản phẩm');
  const secrets = input.lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (!secrets.length) throw new AppError('empty_import', 'Không có dòng dữ liệu hợp lệ');
  if (secrets.length > 5000) throw new AppError('import_too_large', 'Tối đa 5000 dòng mỗi lần nhập');
  const batch = batchId();
  const added = await ctx.db.inventory.add(
    secrets.map((secret) => ({ productId: product.id, ciphertext: ctx.cipher.encrypt(secret), batch })),
  );
  await ctx.db.audit.log({
    guildId: input.guildId,
    actorType: 'staff',
    actorId: input.actorId,
    action: 'inventory.imported',
    targetType: 'product',
    targetId: String(product.id),
    detail: { added, batch }, // secrets never logged
  });
  return { added, batch };
}

/** CSV import: columns `sku,secret` (multi-product) or a single column `secret` with explicit productId. */
export async function importInventoryCsv(
  ctx: AppContext,
  input: { guildId: string; actorId: string; csv: string; productId?: number | null },
): Promise<{ added: number; skipped: number; batch: string }> {
  await assertPerm(ctx, input.guildId, input.actorId, 'inventory.manage');
  const { header, body } = parseCsvRows(input.csv);
  const batch = batchId();
  let added = 0;
  let skipped = 0;
  const byProduct = new Map<number, string[]>();

  if (header.includes('sku') && header.includes('secret')) {
    const skuIdx = header.indexOf('sku');
    const secretIdx = header.indexOf('secret');
    for (const row of body) {
      const sku = (row[skuIdx] ?? '').trim();
      const secret = (row[secretIdx] ?? '').trim();
      if (!sku || !secret) {
        skipped++;
        continue;
      }
      const product = await ctx.db.products.getBySku(sku);
      if (!product) {
        skipped++;
        continue;
      }
      const list = byProduct.get(product.id) ?? [];
      list.push(secret);
      byProduct.set(product.id, list);
    }
  } else if (input.productId) {
    const secretIdx = header.length === 1 && header[0] === 'secret' ? 0 : header.includes('secret') ? header.indexOf('secret') : 0;
    for (const row of body) {
      const secret = (row[secretIdx] ?? '').trim();
      if (!secret) {
        skipped++;
        continue;
      }
      const list = byProduct.get(input.productId) ?? [];
      list.push(secret);
      byProduct.set(input.productId, list);
    }
  } else {
    throw new AppError('bad_csv', 'CSV cần cột sku,secret hoặc productId đích');
  }

  for (const [productId, secrets] of byProduct) {
    added += await ctx.db.inventory.add(
      secrets.map((secret) => ({ productId, ciphertext: ctx.cipher.encrypt(secret), batch })),
    );
  }
  await ctx.db.audit.log({
    guildId: input.guildId,
    actorType: 'staff',
    actorId: input.actorId,
    action: 'inventory.imported_csv',
    targetType: 'batch',
    targetId: batch,
    detail: { added, skipped },
  });
  return { added, skipped, batch };
}

function parseCsvRows(csv: string): { header: string[]; body: string[][] } {
  const rows = parseCsv(csv);
  if (!rows.length) return { header: [], body: [] };
  const first = rows[0]!.map((h) => h.trim().toLowerCase());
  const looksLikeHeader = first.some((h) => ['sku', 'secret', 'code', 'key'].includes(h));
  if (looksLikeHeader) return { header: first, body: rows.slice(1) };
  return { header: ['secret'], body: rows };
}

export async function lowStockReport(ctx: AppContext, guildId: string) {
  const products = await ctx.db.products.list({ activeOnly: true, limit: 500 });
  void guildId;
  const tracked = products.filter((p) => p.stockTracked);
  const counts = await ctx.db.inventory.countsByProduct(tracked.map((p) => p.id));
  return tracked
    .map((p) => ({ product: p, available: counts.get(p.id) ?? 0 }))
    .filter((r) => r.available <= r.product.lowStockThreshold);
}
