import { lowStockReport } from '../services/catalog.js';
import type { AppContext } from '../services/context.js';
import { expireSweep } from '../services/orders.js';
import { WARN } from '../discord/ui.js';

export interface SchedulerHandle {
  stop(): void;
}

/**
 * In-process background jobs (order expiry sweep + low stock alerts).
 * Single-instance deployments are fully covered; see docs/DEPLOY.md for the
 * horizontal-scaling path (external cron / BullMQ) before running >1 replica.
 */
export function startScheduler(ctx: AppContext): SchedulerHandle {
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];

  const sweep = async () => {
    try {
      const n = await expireSweep(ctx);
      if (n > 0) ctx.logger.info({ expired: n }, 'order expiry sweep');
    } catch (err) {
      ctx.logger.error({ err }, 'expiry sweep failed');
    }
  };
  const lowStock = async () => {
    try {
      const guilds = await ctx.db.guildConfig.listGuilds();
      for (const guildId of guilds) {
        const report = await lowStockReport(ctx, guildId);
        if (!report.length) continue;
        const settings = await ctx.db.guildConfig.get(guildId);
        const channel = settings.channels.staffAlerts ?? settings.channels.logs;
        if (!channel) continue;
        await ctx.notifier.sendChannel(channel, {
          embeds: [
            {
              title: '📉 Cảnh báo tồn kho thấp',
              color: WARN,
              description: report.map((r) => `• ${r.product.name}: còn ${r.available}`).join('\n').slice(0, 3000),
            },
          ],
        });
      }
    } catch (err) {
      ctx.logger.error({ err }, 'low stock check failed');
    }
  };

  timers.push(setInterval(() => void sweep(), ctx.env.ORDER_SWEEP_INTERVAL_SECONDS * 1000));
  timers.push(setInterval(() => void lowStock(), ctx.env.LOW_STOCK_CHECK_INTERVAL_MINUTES * 60_000));
  void sweep();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const t of timers) clearInterval(t);
    },
  };
}
