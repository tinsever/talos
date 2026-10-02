# Messages

These examples use a connected `client` and a string `channelId`.

## Send, edit, and reply

```ts
const sent = await client.messages.send(channelId, "Working on it…");
const updated = await sent.edit("Done.");
await updated.react("✅");
```

Send accepts a string or a message body. For text supplied by users, you can
disable mention parsing explicitly:

```ts
await client.messages.send(channelId, {
  content: "Text copied from a user",
  allowed_mentions: { parse: [] },
});
```

Use `message.reply()` inside a `messageCreate` handler to attach a reply reference:

```ts
client.on("messageCreate", async (message) => {
  if (message.author.bot || message.content !== "!hello") return;
  await message.reply("Hello!");
});
```

Replies default to `allowed_mentions: { parse: [], replied_user: false }`, so they
do not ping the original author. Pass your own `allowed_mentions` in the message
body to change that behaviour. Plain `send()` does not set this default.

Message objects expose deeply frozen snapshots. Content and ID getters avoid
walking unrelated payload fields; `author` freezes the author before returning
it, and `data` freezes the full payload before returning it. `edit()` returns a
new `Message`; an older object still contains the original content. Raw dispatch
observers retain mutable payloads and receive separate message snapshots.

## Attach files

Pass `Blob` values and filenames through the second options argument. Talos builds
the multipart body and attachment IDs:

```ts
await client.messages.send(channelId, "Here is the report.", {
  files: [
    {
      name: "report.txt",
      data: new Blob(["42 rows processed\n"], { type: "text/plain" }),
      description: "Processing results",
    },
  ],
});
```

For the API's separate upload flow, upload first and pass the returned attachment
descriptors into the message body:

```ts
const attachments = await client.uploads.upload(channelId, [
  {
    name: "report.txt",
    data: new Blob(["42 rows processed\n"], { type: "text/plain" }),
  },
]);

await client.messages.send(channelId, {
  content: "Here is the report.",
  attachments,
});
```

`uploads.upload()` accepts 1–10 files, has a five-minute deadline by default, and
does not send a message. Instance limits still apply. Its `onProgress` callback
reports completed file bytes rather than progress within each transfer.

## Read history

Fetch a single message when you know its ID:

```ts
const message = await client.messages.fetch(channelId, messageId);
console.log(message.content);
```

Use `history()` to iterate newest first. It fetches pages as you consume them, with
up to 100 messages per request:

```ts
for await (const message of client.messages.history(channelId, { limit: 250 })) {
  console.log(message.id, message.content);
}
```

Set `before` to a message ID to start further back. Omitting `limit` walks all
available history. Breaking out of the loop stops further page requests. Use
`list()` if you need a single page; its query fields follow the API schema, so a
page limit is a string such as `{ limit: "50" }`.

## Cancel an operation

Message methods accept `signal`, `timeoutMs`, and `reason` in their options.
For example:

```ts
await client.messages.send(channelId, "Quick update", {
  signal: AbortSignal.timeout(5_000),
});
```

Cancellation stops local waiting and network work. It does not undo a message
already accepted by the server. See [REST retries](rest.md#retries) before retrying
a failed send.

## Pins and deletion

`message.pin()`, `message.unpin()`, and `message.delete()` operate on that message.
`client.messages.pins(channelId)` returns `{ items, hasMore }`; each item contains
a `message` and `pinnedAt` timestamp.

`client.messages.bulkDelete(channelId, ids)` requires 1–100 unique IDs. Talos
checks that shape locally; the server decides whether the bot is allowed to delete
those messages.

Message-update events are partial payloads. Use `messageUpdate` to learn which
message changed, then fetch it if your handler needs complete data. See
[gateway events](gateway.md#subscribe-to-events).
