# Webhook and Webhooks

Import both classes from `talos-fluxer` or `talos-fluxer/resources`.
Management uses the bot credential. Message execution uses the webhook's own
execution token. See [the source](../../src/resources.ts).

## Webhook

Obtain from `channel.createWebhook(body)`, `channel.webhooks()`, or
`client.webhooks.fetch(id)`. Constructor: `new Webhook(data, resources)`.

Properties: `id` and inherited `data` and `toJSON()`. The execution token is held
privately and removed from the exposed snapshot and its JSON representation.

| Method | Result and behaviour |
| --- | --- |
| `execute(body, options?)` | `Promise<Message>`; sends `WebhookMessageRequest` with this webhook's execution token. |
| `fetchMessage(messageId, options?)` | `Promise<Message>`; fetches a webhook message. |
| `editMessage(messageId, body, options?)` | `Promise<Message>`; uses `WebhookMessageEditRequest`, with optional files. |
| `deleteMessage(messageId, options?)` | `Promise<void>`. |
| `edit(body, options?)` | `Promise<Webhook>`; updates webhook metadata using `WebhookUpdateRequest`. |
| `delete(options?)` | `Promise<void>`; deletes the webhook. |

Execution and message methods throw if the original API response had no execution
token. Metadata operations use the bot's REST authentication. An edit returns a
new snapshot; it does not modify the original wrapper.

## Webhooks

Available as `client.webhooks` or `resources.webhooks`.
Constructor: `new Webhooks(resources)`.

| Method | Result and behaviour |
| --- | --- |
| `fetch(id, options?)` | `Promise<Webhook>`; fetches metadata using bot authentication. |
| `execute(id, token, body, options?)` | `Promise<Message>`; executes with an explicitly supplied webhook token. |

`execute()` requests `wait=true` so the API returns the resulting message.
Its options accept `files`, `signal`, `timeoutMs`, and `reason`. It does not store
the execution token in a resource object.

```ts
const sent = await client.webhooks.execute(webhookId, webhookToken, {
  content: "Build finished.",
  allowed_mentions: { parse: [] },
});
console.log(sent.id);
```

Use `channel.createWebhook()` for creation and `channel.webhooks()` for listing.
