import { z } from 'zod';

/** Per-guild configuration, stored as validated jsonb on guild_configs.settings. */
export const guildSettingsSchema = z.object({
  modules: z
    .object({
      shop: z.boolean().default(true),
      welcome: z.boolean().default(false),
      autorole: z.boolean().default(false),
      verification: z.boolean().default(false),
      antispam: z.boolean().default(false),
      tickets: z.boolean().default(true),
      loyalty: z.boolean().default(true),
      feedbackChannelPost: z.boolean().default(true),
    })
    .default({}),
  channels: z
    .object({
      welcome: z.string().nullable().default(null),
      logs: z.string().nullable().default(null),
      feedback: z.string().nullable().default(null),
      staffAlerts: z.string().nullable().default(null),
      ticketCategory: z.string().nullable().default(null),
      announcements: z.string().nullable().default(null),
    })
    .default({}),
  roles: z
    .object({
      verified: z.string().nullable().default(null),
      autorole: z.string().nullable().default(null),
      moderator: z.string().nullable().default(null),
    })
    .default({}),
  welcomeMessage: z.string().max(1500).nullable().default(null),
  antispam: z
    .object({
      maxMessages: z.number().int().min(2).max(50).default(5),
      windowSeconds: z.number().int().min(1).max(120).default(5),
      maxMentions: z.number().int().min(1).max(20).default(5),
      timeoutSeconds: z.number().int().min(10).max(86400).default(300),
    })
    .default({}),
  loyalty: z
    .object({
      pointsPer1000vnd: z.number().int().min(0).max(100).default(1),
      referralBonus: z.number().int().min(0).max(10000).default(50),
    })
    .default({}),
  payment: z
    .object({
      maxQuantityPerOrder: z.number().int().min(1).max(50).default(10),
    })
    .default({}),
});

export type GuildSettings = z.infer<typeof guildSettingsSchema>;

export function defaultGuildSettings(): GuildSettings {
  return guildSettingsSchema.parse({});
}

export function parseGuildSettings(raw: unknown): GuildSettings {
  return guildSettingsSchema.parse(raw ?? {});
}

/** Merge a partial patch (deep, one level per section) into existing settings. */
export function mergeGuildSettings(current: GuildSettings, patch: Record<string, unknown>): GuildSettings {
  const merged: Record<string, unknown> = { ...current };
  for (const [section, value] of Object.entries(patch)) {
    const existing = (current as Record<string, unknown>)[section];
    if (existing && typeof existing === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
      merged[section] = { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      merged[section] = value;
    }
  }
  return guildSettingsSchema.parse(merged);
}

export const TIERS: { name: string; minPoints: number }[] = [
  { name: 'Thành viên mới', minPoints: 0 },
  { name: 'Khách hàng bạc', minPoints: 100 },
  { name: 'Khách hàng vàng', minPoints: 500 },
  { name: 'Khách hàng kim cương', minPoints: 2000 },
];

export function tierForPoints(points: number): string {
  let tier = TIERS[0]!.name;
  for (const t of TIERS) if (points >= t.minPoints) tier = t.name;
  return tier;
}
