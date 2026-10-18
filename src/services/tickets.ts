import { ticketCode } from '../core/ids.js';
import type { AppContext } from './context.js';

export async function createTicket(
  ctx: AppContext,
  input: { guildId: string; openerId: string; subject: string; orderId?: number | null },
) {
  const ticket = await ctx.db.tickets.create({
    code: ticketCode(),
    guildId: input.guildId,
    openerId: input.openerId,
    subject: input.subject.slice(0, 200),
    orderId: input.orderId ?? null,
  });
  await ctx.db.audit.log({
    guildId: input.guildId,
    actorType: 'user',
    actorId: input.openerId,
    action: 'ticket.created',
    targetType: 'ticket',
    targetId: ticket.code,
    detail: { subject: input.subject, orderId: input.orderId ?? null },
  });
  return ticket;
}

export async function closeTicket(
  ctx: AppContext,
  input: { guildId: string; actorId: string; ticketId: number; reason?: string },
) {
  const ticket = await ctx.db.tickets.update(input.ticketId, { status: 'CLOSED', closedAt: new Date() });
  if (ticket) {
    await ctx.db.audit.log({
      guildId: input.guildId,
      actorType: 'staff',
      actorId: input.actorId,
      action: 'ticket.closed',
      targetType: 'ticket',
      targetId: ticket.code,
      detail: { reason: input.reason ?? null },
    });
  }
  return ticket;
}
