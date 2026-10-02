# Build a command bot

This guide builds a bot with four commands:

| Command | Response |
| --- | --- |
| `!help` | Lists the commands. |
| `!ping` | Replies with `Pong!`. |
| `!last` | Quotes the previous human message in the channel. |
| `!permissions` | Checks whether the command author has the channel's send permission. |

You need a bot token and a channel where the bot can read history and send
messages. Use Node 22+ or Bun. For Node 20, follow the
[WebSocket adapter setup](getting-started.md#node-20-websocket-adapter).

## Install and run

```sh
mkdir talos-bot
cd talos-bot
npm install talos-fluxer
```

Save the following as `bot.mjs`:

```js
import { Client, FluxerAPIError, PermissionFlags } from "talos-fluxer";

const token = process.env.FLUXER_BOT_TOKEN;
if (!token) throw new Error("Set FLUXER_BOT_TOKEN");

const client = new Client({
  token,
  origin: process.env.FLUXER_ORIGIN ?? "https://fluxer.app",
});

client.on("ready", ({ user }) => {
  console.log(`Connected as ${user.username}`);
});

client.on("error", (error) => {
  if (error instanceof FluxerAPIError) {
    console.error("API request failed", error.status, error.code, error.route);
  } else {
    console.error(error);
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  switch (message.content.trim()) {
    case "!help":
      await message.reply("Commands: !help, !ping, !last, !permissions");
      return;

    case "!ping":
      await message.reply("Pong!");
      return;

    case "!last": {
      for await (const previous of client.messages.history(message.channelId, {
        before: message.id,
        limit: 10,
      })) {
        if (previous.author.bot) continue;
        const text = previous.content.slice(0, 200) || "[message without text]";
        await message.reply(`${previous.author.username}: ${text}`);
        return;
      }
      await message.reply("No earlier human message in the last 10 messages.");
      return;
    }

    case "!permissions": {
      if (!message.guildId) {
        await message.reply("Use this command in a guild channel.");
        return;
      }
      const [channel, guild] = await Promise.all([
        client.channels.fetch(message.channelId),
        client.guilds.fetch(message.guildId),
      ]);
      const [member, roles] = await Promise.all([
        guild.members.fetch(message.author.id),
        guild.roles.list(),
      ]);
      const permissions = channel.permissionsFor(member, roles, guild.ownerId);
      const canSend = permissions.has(
        PermissionFlags.VIEW_CHANNEL | PermissionFlags.SEND_MESSAGES,
      );
      await message.reply(`Your channel permissions allow sending: ${canSend}`);
      return;
    }
  }
});

process.once("SIGINT", () => client.disconnect());
process.once("SIGTERM", () => client.disconnect());

await client.connect({ timeoutMs: 30_000 });
```

Run it with your raw bot token:

```sh
export FLUXER_BOT_TOKEN='your-raw-bot-token'
node bot.mjs
```

With Bun, run `bun bot.mjs`. Set `FLUXER_ORIGIN` when using another instance.
Try `!help` after the connected username appears in the terminal.

## How the pieces fit

`Client.connect()` discovers the instance, creates the REST helpers, and opens
the gateway. `messageCreate` delivers a `Message` object. Its `reply()` method
sends through REST and attaches a reference to the incoming message. By default,
replies disable mention parsing and do not ping the replied-to author.

The history iterator fetches older messages only while the loop needs them. The
`before` cursor excludes the command itself. Returning after the first human
message also ends the iterator; it does not fetch the rest of the channel.

Permission checks need the member, every guild role, and the channel's overwrites.
The result is a permission mask. A timeout or another server policy can still
prevent an action; see the [permissions guide](resources.md#check-channel-permissions).

An async handler that rejects reaches the `error` listener. Handlers may overlap,
so keep shared application state safe for concurrent commands. For work that must
be saved in dispatch order, use
[durable dispatch processing](gateway.md#persist-work-before-advancing-the-sequence).

## Add your own command

Add another `case` in the switch. To send a file, pass a `Blob` through the reply's
options. To edit a response later, keep the `Message` returned by `reply()` and
call its `edit()` method. The [messages guide](messages.md) shows both patterns.

For channel operations, fetch a `Channel`. For member operations, fetch a `Guild`
and use `guild.members`. If there is no convenience method for an endpoint, call
`client.rest.request()` with the route template.

Find constructors, properties, and methods in the [class reference](classes/index.md).
The [docs index](index.md) links the more detailed task guides.
