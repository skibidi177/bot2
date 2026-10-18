import { ActivityType, Client, Events, GatewayIntentBits, type GuildMember, type Message } from 'discord.js';
import type { AppContext } from '../services/context.js';
import { commandModules, replyError } from './commands.js';
import { handleComponent, handleModal } from './handlers.js';
import { BRAND } from './ui.js';

const spamWindows = new Map<string, number[]>();
const lastAction = new Map<string, number>();

async function antiSpam(ctx: AppContext, message: Message): Promise<void> {
  if (!message.guild || message.author.bot) return;
  const settings = await ctx.db.guildConfig.get(message.guild.id);
  if (!settings.modules.antispam) return;
  const cfg = settings.antispam;
  const now = Date.now();
  const key = `${message.guild.id}:${message.author.id}`;
  const window = spamWindows.get(key) ?? [];
  window.push(now);
  const recent = window.filter((t) => now - t < cfg.windowSeconds * 1000);
  spamWindows.set(key, recent);

  const mentionSpam = message.mentions.users.size > cfg.maxMentions;
  const flood = recent.length > cfg.maxMessages;
  if (!mentionSpam && !flood) return;

  const last = lastAction.get(key) ?? 0;
  if (now - last < 15_000) return; // avoid stacking punishments
  lastAction.set(key, now);

  const member = message.member;
  if (!member) return;
  // never punish staff or members we cannot moderate
  const staff = await ctx.db.staff.get(message.guild.id, message.author.id);
  if (staff) return;
  try {
    await member.timeout(cfg.timeoutSeconds * 1000, mentionSpam ? 'mention spam' : 'message flood');
    await message.delete().catch(() => undefined);
    await ctx.db.audit.log({
      guildId: message.guild.id,
      actorType: 'system',
      action: 'antispam.timeout',
      targetType: 'user',
      targetId: message.author.id,
      detail: { flood, mentionSpam, count: recent.length },
    });
    if (settings.channels.logs) {
      await ctx.notifier.sendChannel(settings.channels.logs, {
        content: `🛡️ <@${message.author.id}> bị timeout ${cfg.timeoutSeconds}s do ${mentionSpam ? 'mention spam' : 'flood'}.`,
      });
    }
  } catch {
    // missing permissions: log only
    ctx.logger.warn({ guild: message.guild.id }, 'antispam: cannot timeout member');
  }
}

async function onMemberAdd(ctx: AppContext, member: GuildMember): Promise<void> {
  const settings = await ctx.db.guildConfig.get(member.guild.id);
  if (settings.modules.autorole && settings.roles.autorole) {
    await member.roles.add(settings.roles.autorole).catch(() => undefined);
  }
  if (settings.modules.welcome && settings.channels.welcome) {
    const text = (settings.welcomeMessage ?? 'Chào mừng {user} đến với {server}! Gõ `/shop` để xem cửa hàng và `/faq` nếu cần hỗ trợ.')
      .replaceAll('{user}', `<@${member.id}>`)
      .replaceAll('{server}', member.guild.name);
    await ctx.notifier.sendChannel(settings.channels.welcome, {
      embeds: [{ title: '👋 Thành viên mới', description: text, color: BRAND }],
    });
  }
}

/** Builds and wires the gateway client without logging in. */
export function createDiscordClient(ctx: AppContext): Client | null {
  if (!ctx.env.DISCORD_TOKEN) {
    ctx.logger.warn('DISCORD_TOKEN not set — running without Discord gateway (HTTP only)');
    return null;
  }
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.once(Events.ClientReady, (c) => {
    ctx.logger.info({ tag: c.user.tag }, 'Discord gateway ready');
    c.user.setActivity({ name: '/shop · MMO Shop', type: ActivityType.Playing });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const module = commandModules.find((m) => m.data.name === interaction.commandName);
        if (!module) {
          await replyError(interaction, new Error('Lệnh không tồn tại'));
          return;
        }
        await ctx.db.users.upsert({
          id: interaction.user.id,
          username: interaction.user.username,
          globalName: interaction.user.globalName,
        });
        await module.run(ctx, interaction);
      } else if (interaction.isMessageComponent()) {
        await handleComponent(ctx, interaction);
      } else if (interaction.isModalSubmit()) {
        await handleModal(ctx, interaction);
      }
    } catch (err) {
      ctx.logger.error({ err, customId: 'customId' in interaction ? interaction.customId : undefined }, 'interaction failed');
      if (interaction.isChatInputCommand()) await replyError(interaction, err).catch(() => undefined);
      else if (interaction.isRepliable()) {
        await interaction
          .reply({ content: `⚠️ Lỗi: ${(err as Error).message.slice(0, 300)}`, flags: 64 })
          .catch(() => undefined);
      }
    }
  });

  client.on(Events.GuildMemberAdd, (member) => {
    onMemberAdd(ctx, member).catch((err) => ctx.logger.error({ err }, 'guildMemberAdd failed'));
  });

  client.on(Events.MessageCreate, (message) => {
    antiSpam(ctx, message).catch((err) => ctx.logger.error({ err }, 'antispam failed'));
  });

  return client;
}

export async function startDiscord(ctx: AppContext): Promise<Client | null> {
  const client = createDiscordClient(ctx);
  if (!client) return null;
  await client.login(ctx.env.DISCORD_TOKEN);
  return client;
}
