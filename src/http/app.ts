import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomToken } from '../core/crypto.js';
import { AppError, PermissionDeniedError } from '../core/errors.js';
import type { AppContext } from '../services/context.js';
import * as catalog from '../services/catalog.js';
import * as feedbackSvc from '../services/feedback.js';
import * as ordersSvc from '../services/orders.js';
import { ingestWebhook } from '../services/payments-service.js';
import { canManageRole, ROLE_PERMS as ROLE_PERMS_LOOKUP, type Perm } from '../services/rbac.js';
import { mergeGuildSettings } from '../services/guild-settings.js';
import { ADMIN_UI_HTML } from './admin-ui.js';
import { discordAuthUrl, exchangeCode, SessionManager } from './oauth.js';

const SESSION_COOKIE = 'bot2_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export async function buildHttpApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const sessions = new SessionManager(ctx.env.SESSION_SECRET ?? 'dev-only-insecure-secret-change-me-32');

  await app.register(cookie);
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  // keep the raw body so webhook signatures can be verified over exact bytes
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      done(null, body.length ? JSON.parse((body as Buffer).toString('utf8')) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/healthz', async () => ({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - ctx.startedAt.getTime()) / 1000),
    db: ctx.db.kind,
    provider: ctx.env.PAYMENT_PROVIDER,
  }));

  const paymentPage = (title: string, message: string) => `<!doctype html><meta charset="utf-8">
    <title>${title}</title><body style="font-family:system-ui;background:#f8fafc;display:grid;place-items:center;height:100vh">
    <div style="background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;text-align:center">
    <h2>${title}</h2><p>${message}</p><p>Quay lại Discord để theo dõi trạng thái đơn hàng.</p></div></body>`;
  app.get('/payment/return', async (_req, reply) => reply.type('text/html').send(paymentPage('✅ Đã nhận lệnh thanh toán', 'Kết quả sẽ được cập nhật vào đơn hàng của bạn trên Discord.')));
  app.get('/payment/cancel', async (_req, reply) => reply.type('text/html').send(paymentPage('Đã huỷ link thanh toán', 'Đơn hàng vẫn chờ thanh toán tới khi hết hạn.')));

  /* ------------------------------------------------------------ webhooks */
  app.post('/webhooks/payments/:provider', async (req, reply) => {
    const provider = req.params as { provider: string };
    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const result = await ingestWebhook(ctx, provider.provider, rawBody, req.headers as Record<string, string | undefined>);
    if (!result.ack) return reply.code(404).send({ ok: false, reason: result.reason });
    return reply.code(200).send({ ok: true, applied: result.applied, reason: result.reason });
  });

  /* ---------------------------------------------------------- admin auth */
  const oauthConfigured = Boolean(ctx.env.DISCORD_OAUTH_CLIENT_ID && ctx.env.DISCORD_OAUTH_CLIENT_SECRET);

  app.get('/api/admin/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (_req, reply) => {
    if (!oauthConfigured) return reply.code(503).send({ error: 'Discord OAuth chưa được cấu hình' });
    const state = randomToken(16);
    reply.setCookie('bot2_oauth_state', state, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 600, secure: ctx.env.NODE_ENV === 'production' });
    return reply.redirect(discordAuthUrl({ clientId: ctx.env.DISCORD_OAUTH_CLIENT_ID!, redirectUri: `${ctx.env.APP_BASE_URL}/api/admin/auth/callback`, state }));
  });

  app.get('/api/admin/auth/callback', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const query = z.object({ code: z.string(), state: z.string() }).safeParse(req.query);
    const stateCookie = req.cookies?.bot2_oauth_state;
    if (!query.success || !stateCookie || stateCookie !== query.data.state) {
      return reply.code(400).send({ error: 'state không hợp lệ' });
    }
    reply.clearCookie('bot2_oauth_state', { path: '/' });
    const user = await exchangeCode({
      clientId: ctx.env.DISCORD_OAUTH_CLIENT_ID!,
      clientSecret: ctx.env.DISCORD_OAUTH_CLIENT_SECRET!,
      redirectUri: `${ctx.env.APP_BASE_URL}/api/admin/auth/callback`,
      code: query.data.code,
    });
    if (!user) return reply.code(401).send({ error: 'OAuth thất bại' });
    const staffRows = await ctx.db.staff.listForUser(user.userId);
    const bootstrap = ctx.env.BOOTSTRAP_OWNER_IDS.includes(user.userId);
    if (!staffRows.length && !bootstrap) {
      return reply.code(403).send({ error: 'Tài khoản Discord không có quyền quản trị' });
    }
    reply.setCookie(SESSION_COOKIE, sessions.sign({ uid: user.userId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_SECONDS,
    });
    return reply.redirect('/admin');
  });

  app.post('/api/admin/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/admin/auth/me', async (req, reply) => {
    const session = sessions.verify(req.cookies?.[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'chưa đăng nhập' });
    const staff = await ctx.db.staff.listForUser(session.uid);
    return { uid: session.uid, staff, bootstrapOwner: ctx.env.BOOTSTRAP_OWNER_IDS.includes(session.uid) };
  });

  /* ------------------------------------------------------ admin API core */
  async function requirePerm(req: FastifyRequest, reply: FastifyReply, perm: Perm): Promise<string | null> {
    const session = sessions.verify(req.cookies?.[SESSION_COOKIE]);
    if (!session) {
      await reply.code(401).send({ error: 'chưa đăng nhập' });
      return null;
    }
    const guildId = String((req.query as Record<string, string>).guildId ?? (req.body as Record<string, string> | undefined)?.guildId ?? '');
    if (!guildId) {
      await reply.code(400).send({ error: 'thiếu guildId' });
      return null;
    }
    const staff = await ctx.db.staff.get(guildId, session.uid);
    const role = staff?.role ?? (ctx.env.BOOTSTRAP_OWNER_IDS.includes(session.uid) ? ('OWNER' as const) : null);
    if (!role || !ROLE_PERMS_LOOKUP[role].includes(perm)) {
      await reply.code(403).send({ error: 'không có quyền' });
      return null;
    }
    // CSRF hardening: reject cross-origin state-changing requests
    if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== new URL(ctx.env.APP_BASE_URL).host) {
        await reply.code(403).send({ error: 'origin không hợp lệ' });
        return null;
      }
    }
    return `${guildId}|${session.uid}|${role}`;
  }

  function adminRoute(
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    perm: Perm,
    handler: (req: FastifyRequest, reply: FastifyReply, auth: { guildId: string; actorId: string; role: string }) => Promise<unknown>,
  ) {
    app[method](path, async (req, reply) => {
      const auth = await requirePerm(req, reply, perm);
      if (!auth) return;
      const [guildId, actorId, role] = auth.split('|');
      try {
        return await handler(req, reply, { guildId: guildId!, actorId: actorId!, role: role! });
      } catch (err) {
        if (err instanceof AppError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        ctx.logger.error({ err, path }, 'admin api error');
        return reply.code(500).send({ error: 'lỗi hệ thống' });
      }
    });
  }

  adminRoute('get', '/api/admin/overview', 'stats.view', async (req, _reply, auth) => {
    void req;
    const byStatus = await ctx.db.orders.countByStatus(auth.guildId);
    const revenue30 = await ctx.db.orders.revenueSince(auth.guildId, new Date(Date.now() - 30 * 86400_000));
    const stats = await ctx.db.feedback.stats(auth.guildId);
    const tickets = await ctx.db.tickets.list({ guildId: auth.guildId, status: 'OPEN', limit: 100 });
    return { byStatus, revenue30, stats, openTickets: tickets.length };
  });

  adminRoute('get', '/api/admin/orders', 'orders.view', async (req, _reply, auth) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().max(100).default(50), offset: z.coerce.number().default(0) }).parse(req.query);
    return ctx.db.orders.list({ guildId: auth.guildId, status: q.status as never, limit: q.limit, offset: q.offset });
  });

  adminRoute('get', '/api/admin/orders/:code', 'orders.view', async (req, reply, auth) => {
    void auth;
    const code = Number((req.params as { code: string }).code);
    const order = await ctx.db.orders.getByCode(code);
    if (!order) return reply.code(404).send({ error: 'không tìm thấy' });
    return { order, ...(await ordersSvc.orderSummary(ctx, order)), feedback: await ctx.db.feedback.getByOrder(order.id) };
  });

  adminRoute('post', '/api/admin/orders/:code/confirm', 'payments.confirm', async (req, _reply, auth) => {
    const body = z.object({ amount: z.number().int(), ref: z.string().optional(), note: z.string().optional() }).parse(req.body);
    const code = Number((req.params as { code: string }).code);
    return ordersSvc.confirmPaymentManual(ctx, { guildId: auth.guildId, actorId: auth.actorId, orderCode: code, amount: body.amount, providerRef: body.ref, note: body.note });
  });

  adminRoute('post', '/api/admin/orders/:code/cancel', 'orders.manage', async (req, _reply, auth) => {
    const body = z.object({ reason: z.string().default('cancelled via dashboard') }).parse(req.body);
    const order = await ctx.db.orders.getByCode(Number((req.params as { code: string }).code));
    if (!order) throw new AppError('not_found', 'không tìm thấy đơn', 404);
    return ordersSvc.cancelOrder(ctx, { orderId: order.id, actorId: auth.actorId, actorType: 'staff', reason: body.reason });
  });

  adminRoute('post', '/api/admin/orders/:code/refund', 'payments.refund', async (req, _reply, auth) => {
    const body = z.object({ stage: z.enum(['pending', 'done']), reason: z.string() }).parse(req.body);
    return ordersSvc.markRefund(ctx, { guildId: auth.guildId, actorId: auth.actorId, orderCode: Number((req.params as { code: string }).code), stage: body.stage, reason: body.reason });
  });

  adminRoute('post', '/api/admin/orders/:code/complete', 'orders.manage', async (req, _reply, auth) => {
    void req;
    return ordersSvc.completeManual(ctx, { guildId: auth.guildId, actorId: auth.actorId, orderCode: Number((req.params as { code: string }).code) });
  });

  adminRoute('post', '/api/admin/orders/:code/redeliver', 'orders.manage', async (req, _reply, auth) => {
    void req;
    return ordersSvc.redeliver(ctx, { guildId: auth.guildId, actorId: auth.actorId, orderCode: Number((req.params as { code: string }).code) });
  });

  adminRoute('get', '/api/admin/products', 'products.manage', async (req) => {
    const q = z.object({ search: z.string().optional(), limit: z.coerce.number().max(100).default(50) }).parse(req.query);
    const products = await ctx.db.products.list({ search: q.search, limit: q.limit });
    const counts = await ctx.db.inventory.countsByProduct(products.map((p) => p.id));
    return products.map((p) => ({ ...p, available: counts.get(p.id) ?? 0 }));
  });

  adminRoute('post', '/api/admin/products', 'products.manage', async (req, _reply, auth) => {
    const body = z
      .object({
        sku: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        price: z.number().int().min(0),
        categoryId: z.number().int().nullable().optional(),
        description: z.string().max(4000).optional(),
        deliveryMode: z.enum(['AUTO', 'MANUAL']).optional(),
        stockTracked: z.boolean().optional(),
        imageUrl: z.string().url().nullable().optional(),
      })
      .parse(req.body);
    const product = await ctx.db.products.create({ ...body, categoryId: body.categoryId ?? null });
    await ctx.db.audit.log({ guildId: auth.guildId, actorType: 'staff', actorId: auth.actorId, action: 'product.created', targetType: 'product', targetId: String(product.id) });
    return product;
  });

  adminRoute('patch', '/api/admin/products/:id', 'products.manage', async (req, _reply, auth) => {
    const body = z
      .object({ name: z.string().max(200).optional(), price: z.number().int().min(0).optional(), description: z.string().max(4000).optional(), active: z.boolean().optional(), imageUrl: z.string().url().nullable().optional(), lowStockThreshold: z.number().int().min(0).optional() })
      .parse(req.body);
    const product = await ctx.db.products.update(Number((req.params as { id: string }).id), body);
    if (product) await ctx.db.audit.log({ guildId: auth.guildId, actorType: 'staff', actorId: auth.actorId, action: 'product.updated', targetType: 'product', targetId: String(product.id), detail: body });
    return product;
  });

  adminRoute('post', '/api/admin/products/:id/inventory', 'inventory.manage', async (req, _reply, auth) => {
    const body = z.object({ lines: z.string().optional(), csv: z.string().optional() }).parse(req.body);
    const productId = Number((req.params as { id: string }).id);
    if (body.csv) return catalog.importInventoryCsv(ctx, { guildId: auth.guildId, actorId: auth.actorId, csv: body.csv, productId });
    if (body.lines) return catalog.addInventoryLines(ctx, { guildId: auth.guildId, actorId: auth.actorId, productId, lines: body.lines.split('\n') });
    throw new AppError('bad_input', 'cần lines hoặc csv');
  });

  adminRoute('get', '/api/admin/products/:id/inventory', 'inventory.manage', async (req) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().max(200).default(100) }).parse(req.query);
    const rows = await ctx.db.inventory.list({ productId: Number((req.params as { id: string }).id), status: q.status as never, limit: q.limit });
    // never expose ciphertext or plaintext secrets through the API
    return rows.map((r) => ({ id: r.id, status: r.status, batch: r.batch, createdAt: r.createdAt }));
  });

  adminRoute('get', '/api/admin/feedback', 'feedback.manage', async (req, _reply, auth) => {
    const q = z.object({ status: z.enum(['VISIBLE', 'HIDDEN']).optional(), limit: z.coerce.number().max(100).default(50) }).parse(req.query);
    return ctx.db.feedback.list({ guildId: auth.guildId, status: q.status, limit: q.limit });
  });

  adminRoute('post', '/api/admin/feedback/:id/hide', 'feedback.manage', async (req, _reply, auth) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    return feedbackSvc.hideFeedback(ctx, { guildId: auth.guildId, actorId: auth.actorId, feedbackId: Number((req.params as { id: string }).id), reason: body.reason });
  });

  adminRoute('post', '/api/admin/feedback/:id/unhide', 'feedback.manage', async (req, _reply, auth) => {
    void req;
    return feedbackSvc.unhideFeedback(ctx, { guildId: auth.guildId, actorId: auth.actorId, feedbackId: Number((req.params as { id: string }).id) });
  });

  adminRoute('post', '/api/admin/feedback/:id/reply', 'feedback.manage', async (req, _reply, auth) => {
    const body = z.object({ reply: z.string().min(1).max(1000) }).parse(req.body);
    return feedbackSvc.replyFeedback(ctx, { guildId: auth.guildId, actorId: auth.actorId, feedbackId: Number((req.params as { id: string }).id), reply: body.reply });
  });

  adminRoute('get', '/api/admin/coupons', 'coupons.manage', async () => ctx.db.coupons.list(100));

  adminRoute('post', '/api/admin/coupons', 'coupons.manage', async (req, _reply, auth) => {
    const body = z
      .object({ code: z.string().min(2).max(32), kind: z.enum(['percent', 'fixed']), value: z.number().int().min(1), maxUses: z.number().int().nullable().optional(), minOrder: z.number().int().min(0).optional(), expiresAt: z.string().datetime().nullable().optional() })
      .parse(req.body);
    return ctx.db.coupons.create({ ...body, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, createdBy: auth.actorId });
  });

  adminRoute('patch', '/api/admin/coupons/:id', 'coupons.manage', async (req) => {
    const body = z.object({ active: z.boolean().optional(), maxUses: z.number().int().nullable().optional() }).parse(req.body);
    return ctx.db.coupons.update(Number((req.params as { id: string }).id), body);
  });

  adminRoute('get', '/api/admin/tickets', 'tickets.manage', async (req, _reply, auth) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().max(100).default(50) }).parse(req.query);
    return ctx.db.tickets.list({ guildId: auth.guildId, status: q.status as never, limit: q.limit });
  });

  adminRoute('get', '/api/admin/staff', 'staff.manage', async (_req, _reply, auth) => ctx.db.staff.list(auth.guildId));

  adminRoute('post', '/api/admin/staff', 'staff.manage', async (req, _reply, auth) => {
    const body = z.object({ discordId: z.string(), role: z.enum(['OWNER', 'ADMINISTRATOR', 'FINANCE', 'PRODUCT_MANAGER', 'SUPPORT', 'MODERATOR']) }).parse(req.body);
    if (!canManageRole(auth.role as never, body.role)) throw new PermissionDeniedError('Không thể cấp vai trò ngang hoặc cao hơn');
    const row = await ctx.db.staff.grant(auth.guildId, body.discordId, body.role, auth.actorId);
    await ctx.db.audit.log({ guildId: auth.guildId, actorType: 'staff', actorId: auth.actorId, action: 'staff.granted', targetType: 'user', targetId: body.discordId, detail: { role: body.role } });
    return row;
  });

  adminRoute('delete', '/api/admin/staff/:userId', 'staff.manage', async (req, _reply, auth) => {
    const target = await ctx.db.staff.get(auth.guildId, (req.params as { userId: string }).userId);
    if (target && !canManageRole(auth.role as never, target.role)) throw new PermissionDeniedError('Không thể thu quyền vai trò ngang hoặc cao hơn');
    const ok = await ctx.db.staff.revoke(auth.guildId, (req.params as { userId: string }).userId);
    await ctx.db.audit.log({ guildId: auth.guildId, actorType: 'staff', actorId: auth.actorId, action: 'staff.revoked', targetType: 'user', targetId: (req.params as { userId: string }).userId });
    return { ok };
  });

  adminRoute('get', '/api/admin/audit', 'audit.view', async (req, _reply, auth) => {
    const q = z.object({ limit: z.coerce.number().max(200).default(100), action: z.string().optional() }).parse(req.query);
    return ctx.db.audit.list({ guildId: auth.guildId, action: q.action, limit: q.limit });
  });

  adminRoute('get', '/api/admin/config', 'config.manage', async (_req, _reply, auth) => ctx.db.guildConfig.get(auth.guildId));

  adminRoute('patch', '/api/admin/config', 'config.manage', async (req, _reply, auth) => {
    const body = z.object({ patch: z.record(z.unknown()) }).parse(req.body);
    const current = await ctx.db.guildConfig.get(auth.guildId);
    const merged = mergeGuildSettings(current, body.patch);
    await ctx.db.guildConfig.set(auth.guildId, merged);
    await ctx.db.audit.log({ guildId: auth.guildId, actorType: 'staff', actorId: auth.actorId, action: 'config.updated', detail: body.patch });
    return merged;
  });

  /* ----------------------------------------------------------- admin UI */
  app.get('/admin', async (_req, reply) => reply.type('text/html').send(ADMIN_UI_HTML));

  app.setErrorHandler((err: unknown, req, reply) => {
    const error = err as Error & { statusCode?: number };
    ctx.logger.warn({ err: error.message, path: req.url }, 'http error');
    const status = error.statusCode ?? 500;
    reply.code(status).send({ error: status === 500 ? 'lỗi hệ thống' : error.message });
  });

  return app;
}
