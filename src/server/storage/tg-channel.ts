import "server-only";
import bigInt from "big-integer";
import { Api, type TelegramClient } from "telegram";
import type { ChannelPost } from "./types";

/**
 * Channel reads shared by the storage driver and the boot-time restore (which
 * runs before the database exists, so it can't use the driver).
 */

export const postRef = (channelId: string, id: number) => JSON.stringify({ c: channelId, m: id });

export function postFromMessage(m: Api.TypeMessage | undefined, channelId: string): ChannelPost | null {
  if (!(m instanceof Api.Message)) return null;
  const doc = m.media instanceof Api.MessageMediaDocument && m.media.document instanceof Api.Document ? m.media.document : null;
  const fileName = doc?.attributes.find((a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename)?.fileName ?? null;
  return { id: m.id, ref: postRef(channelId, m.id), caption: m.message ?? "", size: doc ? Number(doc.size) : 0, fileName };
}

export async function resolveInputChannel(client: TelegramClient, channelId: string): Promise<{ channel: Api.InputChannel; peer: Api.InputPeerChannel; title: string }> {
  const res = await client.invoke(
    // Bots may address channels they belong to with access_hash = 0.
    new Api.channels.GetChannels({ id: [new Api.InputChannel({ channelId: bigInt(channelId), accessHash: bigInt.zero })] }),
  );
  const chat = res.chats[0];
  if (!(chat instanceof Api.Channel) || !chat.accessHash) throw new Error(`Channel ${channelId} is not accessible — add the bot to it as an admin`);
  return {
    channel: new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash }),
    peer: new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash }),
    title: chat.title,
  };
}

export async function fetchMessages(client: TelegramClient, channel: Api.InputChannel, ids: number[]): Promise<Api.TypeMessage[]> {
  const out: Api.TypeMessage[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const res = await client.invoke(new Api.channels.GetMessages({ channel, id: ids.slice(i, i + 100).map((id) => new Api.InputMessageID({ id })) }));
    if ("messages" in res) out.push(...res.messages);
  }
  return out;
}

export async function pinnedMessage(client: TelegramClient, channel: Api.InputChannel): Promise<Api.Message | null> {
  const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
  const id = (full.fullChat as Api.ChannelFull).pinnedMsgId;
  if (!id) return null;
  const [m] = await fetchMessages(client, channel, [id]);
  return m instanceof Api.Message ? m : null;
}

export async function editMessageCaption(client: TelegramClient, peer: Api.InputPeerChannel, id: number, caption: string) {
  try {
    await client.invoke(new Api.messages.EditMessage({ peer, id, message: caption }));
  } catch (e) {
    if (/MESSAGE_NOT_MODIFIED/.test((e as { errorMessage?: string }).errorMessage ?? String(e))) return;
    throw e;
  }
}
