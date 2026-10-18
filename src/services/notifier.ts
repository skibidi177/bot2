export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EmbedData {
  title?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  url?: string;
  timestamp?: string;
  authorName?: string;
}

export interface MessageFile {
  name: string;
  data: Buffer;
  contentType?: string;
}

export interface MessagePayload {
  content?: string;
  embeds?: EmbedData[];
  files?: MessageFile[];
  /** Discord components are built by the discord layer; services never need them. */
  components?: unknown;
}

/**
 * Outbound message abstraction so business logic never imports discord.js.
 * Production uses DiscordNotifier; tests use CaptureNotifier.
 */
export interface Notifier {
  sendDM(userId: string, payload: MessagePayload): Promise<boolean>;
  sendChannel(channelId: string, payload: MessagePayload): Promise<boolean>;
}

/** Used when the bot runs HTTP-only (no DISCORD_TOKEN): deliveries are logged, never silently dropped. */
export class LoggingNotifier implements Notifier {
  constructor(private readonly log: (msg: string, payload: MessagePayload) => void) {}
  async sendDM(userId: string, payload: MessagePayload): Promise<boolean> {
    this.log(`DM -> ${userId}`, payload);
    return false;
  }
  async sendChannel(channelId: string, payload: MessagePayload): Promise<boolean> {
    this.log(`channel -> ${channelId}`, payload);
    return false;
  }
}

/** Resolves to a real notifier once the Discord client exists (breaks the ctx↔client cycle). */
export class LateBoundNotifier implements Notifier {
  inner: Notifier | null = null;
  async sendDM(userId: string, payload: MessagePayload): Promise<boolean> {
    return this.inner ? this.inner.sendDM(userId, payload) : false;
  }
  async sendChannel(channelId: string, payload: MessagePayload): Promise<boolean> {
    return this.inner ? this.inner.sendChannel(channelId, payload) : false;
  }
}

export class CaptureNotifier implements Notifier {
  dms: { userId: string; payload: MessagePayload }[] = [];
  channels: { channelId: string; payload: MessagePayload }[] = [];
  failDmFor = new Set<string>();
  async sendDM(userId: string, payload: MessagePayload): Promise<boolean> {
    if (this.failDmFor.has(userId)) return false;
    this.dms.push({ userId, payload });
    return true;
  }
  async sendChannel(channelId: string, payload: MessagePayload): Promise<boolean> {
    this.channels.push({ channelId, payload });
    return true;
  }
}
