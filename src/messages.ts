import { snapshot } from "./snapshot.js";
import type { RESTClient } from "./rest.js";
import type {
  MessageCreate,
  MessageData,
  MessageEdit,
  OperationOptions,
  RequestOptions,
} from "./types.js";
export interface FileAttachment {
  data: Blob;
  name: string;
  description?: string;
}
export interface SendOptions extends OperationOptions {
  files?: readonly FileAttachment[];
}
export type MessageInput = string | MessageCreate;
type HistoryQuery = NonNullable<
  RequestOptions<"GET", "/channels/{channel_id}/messages">["query"]
>;

export function multipart(
  body: MessageCreate | MessageEdit,
  files: readonly FileAttachment[],
): FormData {
  const form = new FormData();
  const attachments = [...(body.attachments ?? [])];
  const used = new Set(attachments.map((attachment) => Number(attachment.id)));
  let id = 0;
  for (const file of files) {
    while (used.has(id)) id++;
    attachments.push({
      id,
      filename: file.name,
      ...(file.description === undefined
        ? {}
        : { description: file.description }),
    });
    form.append(`files[${id}]`, file.data, file.name);
    used.add(id++);
  }
  form.set("payload_json", JSON.stringify({ ...body, attachments }));
  return form;
}

export interface PinnedMessagesPage {
  items: { message: Message; pinnedAt: string }[];
  hasMore: boolean;
}

export class Message {
  readonly data: MessageData;
  constructor(
    data: MessageData,
    private readonly messages: Messages,
  ) {
    this.data = snapshot(data);
  }
  get id(): string {
    return this.data.id;
  }
  get channelId(): string {
    return this.data.channel_id;
  }
  get guildId(): string | null {
    return this.data.guild_id ?? null;
  }
  get content(): string {
    return this.data.content;
  }
  get author(): MessageData["author"] {
    return this.data.author;
  }
  reply(input: MessageInput, options?: SendOptions): Promise<Message> {
    const body: MessageCreate =
      typeof input === "string" ? { content: input } : input;
    return this.messages.send(
      this.channelId,
      {
        ...body,
        message_reference: { message_id: this.id, channel_id: this.channelId },
        allowed_mentions: body.allowed_mentions ?? {
          parse: [],
          replied_user: false,
        },
      },
      options,
    );
  }
  edit(input: string | MessageEdit, options?: SendOptions): Promise<Message> {
    return this.messages.edit(this.channelId, this.id, input, options);
  }
  react(emoji: string, options?: OperationOptions): Promise<void> {
    return this.messages.react(this.channelId, this.id, emoji, options);
  }
  pin(options?: OperationOptions): Promise<void> {
    return this.messages.pin(this.channelId, this.id, options);
  }
  unpin(options?: OperationOptions): Promise<void> {
    return this.messages.unpin(this.channelId, this.id, options);
  }
  delete(options?: OperationOptions): Promise<void> {
    return this.messages.delete(this.channelId, this.id, options);
  }
}

export class Messages {
  constructor(private readonly rest: RESTClient) {}
  wrap(data: MessageData): Message {
    return new Message(data, this);
  }
  async send(
    channelId: string,
    input: MessageInput,
    options: SendOptions = {},
  ): Promise<Message> {
    const body: MessageCreate =
      typeof input === "string" ? { content: input } : input;
    const { files, ...control } = options;
    const data = await this.rest.request(
      "POST",
      "/channels/{channel_id}/messages",
      {
        params: { channel_id: channelId },
        body: files?.length ? multipart(body, files) : body,
        ...control,
      },
    );
    return this.wrap(data);
  }
  async fetch(
    channelId: string,
    messageId: string,
    options: OperationOptions = {},
  ): Promise<Message> {
    return this.wrap(
      await this.rest.request(
        "GET",
        "/channels/{channel_id}/messages/{message_id}",
        {
          params: { channel_id: channelId, message_id: messageId },
          ...options,
        },
      ),
    );
  }
  async edit(
    channelId: string,
    messageId: string,
    input: string | MessageEdit,
    options: SendOptions = {},
  ): Promise<Message> {
    const body = typeof input === "string" ? { content: input } : input;
    const { files, ...control } = options;
    return this.wrap(
      await this.rest.request(
        "PATCH",
        "/channels/{channel_id}/messages/{message_id}",
        {
          params: { channel_id: channelId, message_id: messageId },
          body: files?.length ? multipart(body, files) : body,
          ...control,
        },
      ),
    );
  }
  delete(
    channelId: string,
    messageId: string,
    options: OperationOptions = {},
  ): Promise<void> {
    return this.rest.request(
      "DELETE",
      "/channels/{channel_id}/messages/{message_id}",
      {
        params: { channel_id: channelId, message_id: messageId },
        ...options,
      },
    );
  }
  async list(
    channelId: string,
    query: HistoryQuery = {},
    options: OperationOptions = {},
  ): Promise<Message[]> {
    const data = await this.rest.request(
      "GET",
      "/channels/{channel_id}/messages",
      { params: { channel_id: channelId }, query, ...options },
    );
    return data.map((message) => this.wrap(message));
  }
  async pins(
    channelId: string,
    query: NonNullable<
      RequestOptions<"GET", "/channels/{channel_id}/messages/pins">["query"]
    > = {},
    options: OperationOptions = {},
  ): Promise<PinnedMessagesPage> {
    const data = await this.rest.request(
      "GET",
      "/channels/{channel_id}/messages/pins",
      {
        params: { channel_id: channelId },
        query,
        ...options,
      },
    );
    return {
      items: data.items.map((item) => ({
        message: this.wrap(item.message),
        pinnedAt: item.pinned_at,
      })),
      hasMore: data.has_more,
    };
  }
  bulkDelete(
    channelId: string,
    messageIds: readonly string[],
    options: OperationOptions = {},
  ): Promise<void> {
    if (messageIds.length < 1 || messageIds.length > 100)
      throw new RangeError("Bulk deletion requires 1..100 message IDs");
    if (new Set(messageIds).size !== messageIds.length)
      throw new TypeError("Bulk deletion requires unique message IDs");
    return this.rest.request(
      "POST",
      "/channels/{channel_id}/messages/bulk-delete",
      {
        params: { channel_id: channelId },
        body: { message_ids: [...messageIds] },
        ...options,
      },
    );
  }
  react(
    channelId: string,
    messageId: string,
    emoji: string,
    options: OperationOptions = {},
  ): Promise<void> {
    return this.rest.request(
      "PUT",
      "/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me",
      {
        params: { channel_id: channelId, message_id: messageId, emoji },
        ...options,
      },
    );
  }
  unreact(
    channelId: string,
    messageId: string,
    emoji: string,
    options: OperationOptions = {},
  ): Promise<void> {
    return this.rest.request(
      "DELETE",
      "/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me",
      {
        params: { channel_id: channelId, message_id: messageId, emoji },
        ...options,
      },
    );
  }
  pin(
    channelId: string,
    messageId: string,
    options: OperationOptions = {},
  ): Promise<void> {
    return this.rest.request(
      "PUT",
      "/channels/{channel_id}/pins/{message_id}",
      { params: { channel_id: channelId, message_id: messageId }, ...options },
    );
  }
  unpin(
    channelId: string,
    messageId: string,
    options: OperationOptions = {},
  ): Promise<void> {
    return this.rest.request(
      "DELETE",
      "/channels/{channel_id}/pins/{message_id}",
      { params: { channel_id: channelId, message_id: messageId }, ...options },
    );
  }
  /** Newest first. Each page is fetched only when the consumer asks for it. */
  async *history(
    channelId: string,
    options: OperationOptions & { limit?: number; before?: string } = {},
  ): AsyncGenerator<Message> {
    const limit = options.limit ?? Infinity;
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0))
      throw new RangeError("limit must be a non-negative integer");
    const { limit: _, before: __, ...control } = options;
    let before = options.before;
    let count = 0;
    while (count < limit) {
      options.signal?.throwIfAborted();
      const pageSize = Math.min(100, limit - count);
      const page = await this.list(
        channelId,
        {
          limit: String(pageSize),
          ...(before === undefined ? {} : { before }),
        },
        control,
      );
      for (const message of page) {
        options.signal?.throwIfAborted();
        if (count++ >= limit) return;
        yield message;
      }
      const next = page.at(-1)?.id;
      if (page.length < pageSize || !next || next === before) return;
      before = next;
    }
  }
}
