# Getting started

You need a Fluxer bot token and a channel the bot can access. Use the raw token:
Talos adds the `Bot` prefix to REST requests itself.

## Install

```sh
npm install talos-fluxer
```

With Bun, use `bun add talos-fluxer`. The core package has no runtime dependencies.

The package supports Node 20 and newer. The bot below uses the global WebSocket
available in Node 22+ and Bun. On Node 20, install `ws` and use the adapter shown
below. REST-only scripts do not need a WebSocket implementation.

## Run a ping bot

Save this as `bot.mjs`:

```js
import { Client } from "talos-fluxer";

const token = process.env.FLUXER_BOT_TOKEN;
if (!token) throw new Error("Set FLUXER_BOT_TOKEN before starting the bot");

const client = new Client({ token });

client.on("error", (error) => console.error(error));
client.on("ready", ({ user }) => {
  console.log(`Connected as ${user.username}`);
});
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.content === "!ping") await message.reply("Pong!");
});

process.once("SIGINT", () => client.disconnect());
process.once("SIGTERM", () => client.disconnect());

await client.connect();
```

Set the token and run the file:

```sh
export FLUXER_BOT_TOKEN='your-raw-bot-token'
node bot.mjs
```

You can also run it with `bun bot.mjs`. Once it prints the connected username,
send `!ping` in a channel where the bot can read and send messages. It should reply
with `Pong!`. The bot-author check prevents bots from answering each other.

Register listeners before `connect()`. It resolves after the gateway's `READY`
event; initialization failures reject the promise. The `error` listener also
receives errors thrown or rejected by your event handlers.

## Node 20 WebSocket adapter

Install `ws` with `npm install ws`. Add its import to `bot.mjs` and replace the
client construction:

```js
import WebSocket from "ws";

const client = new Client({
  token,
  gateway: { webSocket: (url) => new WebSocket(url) },
});
```

For TypeScript projects, also install `@types/ws` as a development dependency.

## Connect to another instance

`Client` discovers the public API and gateway through `/.well-known/fluxer`.
The default origin is `https://fluxer.app`. To use another instance:

```ts
import { Client } from "talos-fluxer";

const client = new Client({
  token,
  origin: "https://chat.example.org",
});
await client.connect({ timeoutMs: 30_000 });
```

If discovery is unavailable, supply the instance's advertised endpoints instead:

```ts
import { Client } from "talos-fluxer";

const client = new Client({
  token,
  endpoints: {
    api_public: "https://chat.example.org/api",
    gateway: "wss://gateway.example.org",
  },
});
await client.connect();
```

Those are example URLs; replace them with your instance's values. Use
`api_public`, including its path prefix. Talos handles the `/v1` suffix.
Supplying `endpoints` skips discovery.

## When startup or replies fail

| Symptom | What to check |
| --- | --- |
| Token validation throws | Remove surrounding whitespace and any `Bot`, `Bearer`, or `Admin` prefix. |
| Missing WebSocket factory | Use Node 22+/Bun or inject the Node 20 adapter above. |
| Discovery fails | Check the instance origin and its `/.well-known/fluxer` response. |
| `Connect the client before using …` | Wait for `connect()` before calling REST or resource methods. |
| Connected, but no reply | Check the exact `!ping` text, the bot's channel access, and the `error` output. |
| A reply returns HTTP 403 | Check the bot's channel permissions; see [permissions](resources.md#check-channel-permissions). |

`connect()` has a 60-second deadline by default. Call `disconnect()` to stop an
established client. A second `connect()` while it is running rejects.
