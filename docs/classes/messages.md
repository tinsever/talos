# Message, Messages, and Uploads

Import these classes from `talos-fluxer`. `Uploads` is also exported from
`talos-fluxer/uploads`. See [message examples](../messages.md).

## Message

Usually returned by a send, fetch, or `messageCreate` event. The constructor is
`new Message(data, messages)`, where `messages` is a `Messages` manager.

| Property | Value |
| --- | --- |
| `data` | Frozen `MessageData` snapshot. |
| `id`, `channelId` | Message and channel IDs. |
| `guildId` | Guild ID, or `null` outside a guild. |
| `content` | Message text. |
| `author` | The author from the API payload. |

| Method | Result and behaviour |
| --- | --- |
| `reply(input, options?)` | `Promise<Message>`; adds a reply reference and defaults to no mentions. |
| `edit(input, options?)` | `Promise<Message>`; returns the updated snapshot. |
| `react(emoji, options?)` | `Promise<void>`; adds the bot's reaction. |
| `pin(options?)` | `Promise<void>`; pins the message. |
| `unpin(options?)` | `Promise<void>`; unpins the message. |
| `delete(options?)` | `Promise<void>`; deletes the message. |

`reply` accepts text or `MessageCreate`; `edit` accepts text or `MessageEdit`.
Both support files through `SendOptions`. Other methods accept operation options.
An edit does not mutate the existing object's `data`.

## Messages

Available as `client.messages` or `resources.messages`. For REST-only code, use
`new Messages(rest)`. See the [source and query types](../../src/messages.ts).

| Method | Result and behaviour |
| --- | --- |
| `wrap(data)` | `Message`; wraps a payload without making an API request. |
| `send(channelId, input, options?)` | `Promise<Message>`; sends text or `MessageCreate`. |
| `fetch(channelId, messageId, options?)` | `Promise<Message>`; retrieves one message. |
| `edit(channelId, messageId, input, options?)` | `Promise<Message>`; edits text or `MessageEdit`. |
| `delete(channelId, messageId, options?)` | `Promise<void>`; deletes one message. |
| `list(channelId, query?, options?)` | `Promise<Message[]>`; fetches one history page. |
| `history(channelId, options?)` | `AsyncGenerator<Message>`; walks newest first with optional total `limit` and `before` cursor. |
| `pins(channelId, query?, options?)` | `Promise<PinnedMessagesPage>`; returns `{ items, hasMore }`, with `message` and `pinnedAt` in each item. |
| `bulkDelete(channelId, messageIds, options?)` | `Promise<void>`; requires 1–100 unique IDs. |
| `react(channelId, messageId, emoji, options?)` | `Promise<void>`; adds the current user's reaction. |
| `unreact(channelId, messageId, emoji, options?)` | `Promise<void>`; removes the current user's reaction. |
| `pin(channelId, messageId, options?)` | `Promise<void>`. |
| `unpin(channelId, messageId, options?)` | `Promise<void>`. |

`list` uses API query fields, including a string page limit. `history` accepts a
numeric total limit, fetches pages of up to 100, and stops fetching when you leave
the loop. Send and edit options accept `files` in addition to `signal`,
`timeoutMs`, and `reason`.

`multipart(body, files)` is the separate helper used to build a multipart body;
it is a function, not a class. You usually do not need it when using this manager.

## Uploads

Available as `client.uploads`. For standalone code, construct
`new Uploads(rest, { fetch?, concurrency? }?)`. Transfer concurrency defaults to
four. The `fetch` override handles upload transfers separately from REST.

| Method | Result and behaviour |
| --- | --- |
| `upload(channelId, files, options?)` | Promise of `ClientUploadedAttachmentRequest[]`; uploads 1–10 files and returns descriptors for a message body. |

Each file needs `data: Blob` and `name`; `description` is optional. Options accept
`signal`, `timeoutMs`, and `onProgress({ completedBytes, totalBytes })`. The
default deadline is five minutes. Progress counts completed transfers rather
than individual network chunks.

This method does not send a message. Pass its returned descriptors as
`attachments` to `Messages.send()`. Alternatively, pass `files` directly to send
for the multipart message flow. See [the upload source](../../src/uploads.ts)
and [UploadError](errors.md#uploaderror).
