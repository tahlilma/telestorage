// Checks your Telegram configuration and finds your channel id.
//
//   npm run tg:setup
//
// 1. Logs in every bot in TG_BOT_TOKENS and prints its username / data centre.
// 2. If TG_CHANNEL_ID is set, verifies each bot can reach the channel and has the
//    admin rights Telestorage needs.
// 3. If it isn't set, waits for you to post a message in the channel and prints
//    the id to put in .env.
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Api, TelegramClient, Logger, sessions } = require("telegram");
const bigInt = require("big-integer");

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const tokens = (process.env.TG_BOT_TOKENS ?? "").split(/[\s,]+/).filter(Boolean);
const channelId = (process.env.TG_CHANNEL_ID ?? "").replace(/^-100/, "");

if (!apiId || !apiHash || !tokens.length) {
  console.error("Set TG_API_ID, TG_API_HASH and TG_BOT_TOKENS in .env first (see .env.example).");
  process.exit(1);
}

async function login(token) {
  const client = new TelegramClient(new sessions.StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger("error"),
  });
  await client.start({ botAuthToken: token });
  const me = await client.getMe();
  return { client, me };
}

const clients = [];
for (const token of tokens) {
  try {
    const { client, me } = await login(token);
    clients.push(client);
    console.log(`✓ @${me.username} (id ${me.id}) logged in — home DC ${client.session.dcId}`);
  } catch (e) {
    console.error(`✗ token ${token.split(":")[0]}…: ${e.errorMessage ?? e.message}`);
  }
}
if (!clients.length) process.exit(1);

if (channelId) {
  for (const client of clients) {
    const me = await client.getMe();
    try {
      const res = await client.invoke(
        new Api.channels.GetChannels({ id: [new Api.InputChannel({ channelId: bigInt(channelId), accessHash: bigInt.zero })] }),
      );
      const chat = res.chats[0];
      const r = chat.adminRights;
      const ok = (flag) => (chat.creator || r?.[flag] ? "✓" : "✗");
      console.log(
        `✓ @${me.username} sees "${chat.title}" — post ${ok("postMessages")}  delete ${ok("deleteMessages")}  pin ${ok("pinMessages")}  edit ${ok("editMessages")}`,
      );
      if (!r?.postMessages && !chat.creator) console.log(`  ! give @${me.username} the "Post messages" admin right`);
    } catch (e) {
      console.error(`✗ @${me.username} cannot access channel ${channelId}: ${e.errorMessage ?? e.message}`);
      console.error("  Add the bot to the channel as an administrator, then run this again.");
    }
  }
  await Promise.all(clients.map((c) => c.destroy()));
  process.exit(0);
}

// No channel configured yet: listen for a post in any channel the first bot administers.
const client = clients[0];
const me = await client.getMe();
console.log(`
TG_CHANNEL_ID is not set. To find it:
  1. Create a PRIVATE channel in Telegram.
  2. Add @${me.username}${clients.length > 1 ? " (and your other bots)" : ""} as administrator(s) with "Post messages" and "Delete messages".
  3. Post any message in the channel now. Waiting up to 3 minutes…
`);
await client.invoke(new Api.updates.GetState());
const timer = setTimeout(() => {
  console.error("Timed out — no channel post seen.");
  process.exit(1);
}, 180_000);
client.addEventHandler((update) => {
  const msg = update?.message;
  const id = msg?.peerId?.channelId;
  if ((update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateEditChannelMessage) && id) {
    clearTimeout(timer);
    console.log(`✓ Found channel. Add this to .env:\n\n  TG_CHANNEL_ID=-100${id}\n`);
    Promise.all(clients.map((c) => c.destroy())).finally(() => process.exit(0));
  }
});
