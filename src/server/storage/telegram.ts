import "server-only";
import crypto from "node:crypto";
import bigInt from "big-integer";
// Root-entry imports only: deep paths can't be resolved by Node's ESM loader once externalized.
import { Api, Logger, TelegramClient, errors, sessions } from "telegram";
import { BLOCK_SIZE, config } from "../config";
import { kv } from "../db";
import { log, metrics } from "../metrics";
import { PoolDriver, type Transport } from "./pool";
import { editMessageCaption, pinnedMessage, postFromMessage } from "./tg-channel";
import { FloodWaitError, GoneError, TransientError, type ChannelPost } from "./types";

const LOCATION_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED_LOCATIONS = 20_000;

interface Located {
  location: Api.InputDocumentFileLocation;
  dcId: number;
  at: number;
}

function errorCode(e: unknown): string {
  if (e instanceof errors.RPCError) return e.errorMessage;
  if (e instanceof Error) return e.message.slice(0, 120);
  return String(e).slice(0, 120);
}

function isTransient(e: unknown): boolean {
  if (e instanceof errors.FloodWaitError) return false;
  if (e instanceof errors.RPCError) {
    return e.code === 500 || e.code === -503 || /TIMEOUT|RPC_CALL_FAIL|RPC_MCGET_FAIL|INTERNAL|WORKER_BUSY/.test(e.errorMessage);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /disconnect|not connected|timeout|ECONNRESET|EPIPE|socket|closed|Cannot send requests/i.test(msg);
}

/** Normalises GramJS errors into the pool's vocabulary (message = Telegram error code). */
function translate(e: unknown): Error {
  if (e instanceof errors.FloodWaitError) return new FloodWaitError(e.seconds, `FLOOD_WAIT_${e.seconds}`);
  if (e instanceof GoneError || e instanceof TransientError || e instanceof FloodWaitError) return e;
  if (isTransient(e)) return new TransientError(errorCode(e));
  return new Error(errorCode(e));
}

function randomLong() {
  return bigInt(crypto.randomBytes(8).readBigInt64BE().toString());
}

/**
 * One Telegram bot logged in over MTProto (not the HTTP Bot API, so no
 * 20/50 MB limits), holding several connections that share one auth key.
 * Every method is a single attempt; the pool owns retries and failover.
 */
export class TelegramTransport implements Transport {
  readonly id: string;
  readonly connections: number;
  label: string;
  dcId = 0;
  private clients: TelegramClient[] = [];
  private inputChannel?: Api.InputChannel;
  private peer?: Api.InputPeerChannel;
  private channelTitle: string | null = null;
  private readonly locations = new Map<number, Located>();
  private readonly locating = new Map<number, Promise<Located>>();
  private locateBatch = new Map<number, { resolve: (l: Located) => void; reject: (e: unknown) => void }>();
  private locateTimer: NodeJS.Immediate | null = null;
  private warmTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly index: number,
    readonly token: string,
  ) {
    this.id = token.split(":")[0];
    this.label = `bot ${this.id}`;
    this.connections = config().tg.connectionsPerBot;
  }

  // ---- lifecycle -----------------------------------------------------------

  private makeClient(session: string) {
    const { apiId, apiHash } = config().tg;
    return new TelegramClient(new sessions.StringSession(session), apiId, apiHash, {
      connectionRetries: 5,
      retryDelay: 1000,
      autoReconnect: true,
      requestRetries: 2,
      // Surface every flood wait: the pool decides whether to wait or fail over.
      floodSleepThreshold: 0,
      deviceModel: "telestorage",
      systemVersion: `${process.platform} node ${process.version}`,
      appVersion: "2.0.0",
      baseLogger: new Logger("error" as ConstructorParameters<typeof Logger>[0]),
    });
  }

  async start() {
    const sessionKey = `tg.session.${this.id}`;
    let primary = this.makeClient(kv.get(sessionKey) ?? "");
    try {
      await primary.start({ botAuthToken: this.token });
    } catch (e) {
      // A key used from two places at once gets revoked by Telegram — log in afresh.
      if (/AUTH_KEY_(DUPLICATED|UNREGISTERED|INVALID)|SESSION_REVOKED/.test(errorCode(e))) {
        log.warn("telegram", `bot ${this.id}: saved session rejected (${errorCode(e)}), logging in again`);
        kv.delete(sessionKey);
        await primary.destroy().catch(() => {});
        primary = this.makeClient("");
        await primary.start({ botAuthToken: this.token });
      } else {
        await primary.destroy().catch(() => {});
        throw translate(e);
      }
    }
    const session = (primary.session as InstanceType<typeof sessions.StringSession>).save();
    kv.set(sessionKey, session);

    // Extra connections share the auth key (no re-login) but get independent TCP
    // streams, which multiplies throughput on high-latency links.
    const extras = await Promise.all(
      Array.from({ length: this.connections - 1 }, async () => {
        const c = this.makeClient(session);
        await c.connect();
        return c;
      }),
    );
    this.clients = [primary, ...extras];

    const me = (await primary.getMe()) as Api.User;
    this.label = `@${me.username ?? me.firstName ?? this.id}`;
    this.dcId = primary.session.dcId;
    await this.resolveChannel();
    this.keepWarm();
  }

  private async resolveChannel() {
    const channelId = config().tg.channelId;
    const res = await this.clients[0].invoke(
      new Api.channels.GetChannels({
        // Bots may address channels they belong to with access_hash = 0.
        id: [new Api.InputChannel({ channelId: bigInt(channelId), accessHash: bigInt.zero })],
      }),
    );
    const chat = res.chats[0];
    if (!(chat instanceof Api.Channel) || !chat.accessHash) {
      throw new Error(`Channel ${channelId} is not accessible — add ${this.label} to it as an admin`);
    }
    if (chat.adminRights && !chat.adminRights.postMessages && !chat.creator) {
      log.warn("telegram", `${this.label} lacks "Post messages" permission in "${chat.title}"`);
    }
    if (chat.adminRights && !chat.adminRights.deleteMessages && !chat.creator) {
      log.warn("telegram", `${this.label} lacks "Delete messages" permission — deleted files would stay in the channel`);
    }
    this.inputChannel = new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash });
    this.peer = new Api.InputPeerChannel({ channelId: chat.id, accessHash: chat.accessHash });
    this.channelTitle = chat.title;
  }

  async stop() {
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = null;
    await Promise.all(this.clients.map((c) => c.destroy().catch(() => {})));
    this.clients = [];
  }

  /**
   * Keeps every connection's file-transfer link to the home DC open.
   *
   * GramJS opens a separate link per DC for uploads and downloads and closes it
   * 30 s after its last use, so after any pause the next file opened would pay
   * a fresh TCP + MTProto handshake (0.5–1.5 s, sometimes a timeout). Borrowing
   * the link every 20 s resets that timer; a ping every minute keeps NAT
   * mappings alive and finds dead links in the background, not when you click.
   */
  private keepWarm() {
    if (this.warmTimer) clearInterval(this.warmTimer);
    let tick = 0;
    const warm = () => {
      const ping = tick++ % 3 === 0;
      for (const client of this.clients) {
        void client
          .getSender(this.dcId)
          .then((sender) => (ping ? client.invokeWithSender(new Api.Ping({ pingId: randomLong() }), sender) : undefined))
          .catch(() => {});
      }
    };
    warm();
    this.warmTimer = setInterval(warm, 20_000);
    this.warmTimer.unref?.();
  }

  connected(conn: number) {
    return Boolean(this.clients[conn]?.connected);
  }

  channel() {
    return this.channelTitle === null ? null : { id: config().tg.channelId, title: this.channelTitle };
  }

  private client(conn: number): TelegramClient {
    const c = this.clients[conn] ?? this.clients[0];
    if (!c) throw new TransientError("NOT_CONNECTED");
    return c;
  }

  // ---- upload --------------------------------------------------------------

  async uploadPiece(conn: number, fileId: string, piece: number, totalPieces: number, big: boolean, bytes: Buffer) {
    const client = this.client(conn);
    try {
      // Same pattern as GramJS: uploads go through a dedicated sender to the home DC.
      const sender = await client.getSender(client.session.dcId);
      const request = big
        ? new Api.upload.SaveBigFilePart({ fileId: bigInt(fileId), filePart: piece, fileTotalParts: totalPieces, bytes })
        : new Api.upload.SaveFilePart({ fileId: bigInt(fileId), filePart: piece, bytes });
      const ok = await client.invokeWithSender(request, sender);
      if (!ok) throw new TransientError("SAVE_PART_FALSE");
    } catch (e) {
      throw translate(e);
    }
  }

  async commit(conn: number, fileId: string, totalPieces: number, big: boolean, fileName: string, caption: string): Promise<string> {
    const client = this.client(conn);
    const randomId = randomLong();
    const file = big
      ? new Api.InputFileBig({ id: bigInt(fileId), parts: totalPieces, name: fileName })
      : new Api.InputFile({ id: bigInt(fileId), parts: totalPieces, name: fileName, md5Checksum: "" });
    try {
      const updates = await client.invoke(
        new Api.messages.SendMedia({
          peer: this.peer!,
          media: new Api.InputMediaUploadedDocument({
            file,
            mimeType: "application/octet-stream",
            attributes: [new Api.DocumentAttributeFilename({ fileName })],
            forceFile: true,
          }),
          message: caption,
          randomId,
          silent: true,
        }),
      );
      const msgId = this.extractMessageId(updates, randomId);
      return JSON.stringify({ c: config().tg.channelId, m: msgId });
    } catch (e) {
      throw translate(e);
    }
  }

  private extractMessageId(updates: Api.TypeUpdates, randomId: bigInt.BigInteger): number {
    const list =
      updates instanceof Api.Updates || updates instanceof Api.UpdatesCombined
        ? updates.updates
        : updates instanceof Api.UpdateShort
          ? [updates.update]
          : [];
    let id: number | undefined;
    let message: Api.Message | undefined;
    for (const u of list) {
      if (u instanceof Api.UpdateMessageID && u.randomId?.equals(randomId)) id = u.id;
      if ((u instanceof Api.UpdateNewChannelMessage || u instanceof Api.UpdateNewMessage) && u.message instanceof Api.Message) {
        message = u.message;
      }
    }
    id ??= message?.id;
    if (!id) throw new Error("Telegram did not return a message id for the uploaded part");
    // Prime the location cache so the first download needs no extra round trip.
    if (message?.id === id) {
      const loc = this.locationFrom(message);
      if (loc) this.remember(id, loc);
    }
    return id;
  }

  async pin(conn: number, ref: string) {
    const { m } = JSON.parse(ref) as { m: number };
    const client = this.client(conn);
    let updates: Api.TypeUpdates;
    try {
      updates = await client.invoke(new Api.messages.UpdatePinnedMessage({ peer: this.peer!, id: m, silent: true }));
    } catch (e) {
      throw translate(e);
    }
    // Pinning leaves a "pinned a file" service post in the channel; remove it so the chat stays clean.
    const list = updates instanceof Api.Updates || updates instanceof Api.UpdatesCombined ? updates.updates : [];
    const service = list
      .map((u) => (u instanceof Api.UpdateNewChannelMessage ? u.message : null))
      .filter((msg): msg is Api.MessageService => msg instanceof Api.MessageService && msg.action instanceof Api.MessageActionPinMessage)
      .map((msg) => msg.id);
    if (service.length) await client.invoke(new Api.channels.DeleteMessages({ channel: this.inputChannel!, id: service })).catch(() => {});
  }

  async pinnedPost(conn: number): Promise<ChannelPost | null> {
    try {
      return postFromMessage((await pinnedMessage(this.client(conn), this.inputChannel!)) ?? undefined, config().tg.channelId);
    } catch (e) {
      throw translate(e);
    }
  }

  async editCaption(conn: number, ref: string, caption: string) {
    const { m } = JSON.parse(ref) as { m: number };
    try {
      await editMessageCaption(this.client(conn), this.peer!, m, caption);
    } catch (e) {
      throw translate(e);
    }
  }

  session(): string | null {
    const c = this.clients[0];
    return c ? (c.session as InstanceType<typeof sessions.StringSession>).save() : null;
  }

  async deleteRefs(conn: number, refs: string[]) {
    const ids = refs.map((r) => (JSON.parse(r) as { m: number }).m).filter(Number.isFinite);
    if (!ids.length) return;
    try {
      await this.client(conn).invoke(new Api.channels.DeleteMessages({ channel: this.inputChannel!, id: ids }));
    } catch (e) {
      // Already deleted (e.g. by hand in Telegram) is success for our purposes.
      if (/MESSAGE_DELETE_FORBIDDEN/.test(errorCode(e))) throw new Error(`${this.label} may not delete messages in this channel`);
      throw translate(e);
    }
    for (const id of ids) this.locations.delete(id);
  }

  // ---- download ------------------------------------------------------------

  private locationFrom(m: Api.TypeMessage): Located | null {
    if (!(m instanceof Api.Message) || !(m.media instanceof Api.MessageMediaDocument)) return null;
    const doc = m.media.document;
    if (!(doc instanceof Api.Document)) return null;
    return {
      location: new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: "",
      }),
      dcId: doc.dcId,
      at: Date.now(),
    };
  }

  private remember(id: number, loc: Located) {
    this.locations.delete(id);
    this.locations.set(id, loc);
    if (this.locations.size > MAX_CACHED_LOCATIONS) this.locations.delete(this.locations.keys().next().value!);
  }

  /** Resolves a message's file location. Concurrent lookups in the same tick share one RPC. */
  private locate(msgId: number): Promise<Located> {
    const cached = this.locations.get(msgId);
    if (cached && Date.now() - cached.at < LOCATION_TTL_MS) return Promise.resolve(cached);
    const existing = this.locating.get(msgId);
    if (existing) return existing;
    const p = new Promise<Located>((resolve, reject) => {
      this.locateBatch.set(msgId, { resolve, reject });
      this.locateTimer ??= setImmediate(() => void this.flushLocate());
    });
    this.locating.set(msgId, p);
    p.then(
      () => this.locating.delete(msgId),
      () => this.locating.delete(msgId),
    );
    return p;
  }

  private async flushLocate() {
    this.locateTimer = null;
    const batch = this.locateBatch;
    this.locateBatch = new Map();
    const ids = [...batch.keys()];
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100);
      const t0 = performance.now();
      try {
        const res = await this.client(0).invoke(
          new Api.channels.GetMessages({ channel: this.inputChannel!, id: slice.map((id) => new Api.InputMessageID({ id })) }),
        );
        metrics.latency.tgGetMessages.record(performance.now() - t0);
        const messages = "messages" in res ? res.messages : [];
        const byId = new Map(messages.map((m) => [m.id, m]));
        for (const id of slice) {
          const loc = byId.has(id) ? this.locationFrom(byId.get(id)!) : null;
          if (loc) {
            this.remember(id, loc);
            batch.get(id)!.resolve(loc);
          } else {
            batch.get(id)!.reject(new GoneError(`Telegram message ${id} is missing (deleted from the channel?)`));
          }
        }
      } catch (e) {
        const err = translate(e);
        for (const id of slice) batch.get(id)!.reject(err);
      }
    }
  }

  async readBlock(conn: number, ref: string, offset: number, length: number): Promise<Buffer> {
    const { m } = JSON.parse(ref) as { m: number };
    const client = this.client(conn);
    let refreshed = false;
    let migrations = 0;
    for (;;) {
      const loc = await this.locate(m);
      try {
        const sender = await client.getSender(loc.dcId);
        const res = await client.invokeWithSender(
          new Api.upload.GetFile({
            location: loc.location,
            offset: bigInt(offset),
            // Always a full aligned MiB; Telegram returns fewer bytes at EOF.
            limit: BLOCK_SIZE,
            precise: false,
            cdnSupported: false,
          }),
          sender,
        );
        if (!(res instanceof Api.upload.File)) throw new Error("Unexpected CDN redirect from Telegram");
        return res.bytes.length > length ? res.bytes.subarray(0, length) : res.bytes;
      } catch (e) {
        const code = errorCode(e);
        if (!refreshed && code.startsWith("FILE_REFERENCE_")) {
          // File references expire; fetching the message again issues a fresh one.
          refreshed = true;
          this.locations.delete(m);
          metrics.inc("tg.fileRefRefresh");
          continue;
        }
        if (e instanceof errors.FileMigrateError && migrations++ < 2) {
          loc.dcId = e.newDc;
          continue;
        }
        throw translate(e);
      }
    }
  }
}

export function createTelegramDriver(): PoolDriver {
  const cfg = config().tg;
  return new PoolDriver(
    "telegram",
    cfg.botTokens.map((t, i) => new TelegramTransport(i, t)),
    {
      perConnectionConcurrency: cfg.connectionConcurrency,
      commitsPerMinute: cfg.commitsPerMinute,
      commitBurst: 4,
      hedging: cfg.hedging,
    },
  );
}
