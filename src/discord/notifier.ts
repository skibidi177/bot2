import { AttachmentBuilder, EmbedBuilder, type Client } from 'discord.js';
import type { EmbedData, MessagePayload, Notifier } from '../services/notifier.js';

export function toEmbed(e: EmbedData): EmbedBuilder {
  const emb = new EmbedBuilder();
  if (e.title) emb.setTitle(e.title);
  if (e.description) emb.setDescription(e.description);
  if (e.color !== undefined) emb.setColor(e.color);
  if (e.fields) for (const f of e.fields) emb.addFields({ name: f.name, value: f.value, inline: f.inline });
  if (e.footer) emb.setFooter({ text: e.footer });
  if (e.imageUrl) emb.setImage(e.imageUrl);
  if (e.thumbnailUrl) emb.setThumbnail(e.thumbnailUrl);
  if (e.url) emb.setURL(e.url);
  if (e.timestamp) emb.setTimestamp(new Date(e.timestamp));
  if (e.authorName) emb.setAuthor({ name: e.authorName });
  return emb;
}

function toPayload(p: MessagePayload) {
  return {
    content: p.content,
    embeds: p.embeds?.map(toEmbed),
    files: p.files?.map((f) => new AttachmentBuilder(f.data, { name: f.name })),
    components: p.components as MessagePayload['components'],
  };
}

export class DiscordNotifier implements Notifier {
  constructor(private readonly client: Client) {}

  async sendDM(userId: string, payload: MessagePayload): Promise<boolean> {
    try {
      const user = await this.client.users.fetch(userId);
      await user.send(toPayload(payload) as never);
      return true;
    } catch {
      return false;
    }
  }

  async sendChannel(channelId: string, payload: MessagePayload): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('send' in channel)) return false;
      await (channel as { send: (p: unknown) => Promise<unknown> }).send(toPayload(payload));
      return true;
    } catch {
      return false;
    }
  }
}
