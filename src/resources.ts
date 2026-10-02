import { LRUCache } from "./cache.js";
import { Messages, Message } from "./messages.js";
import type {
  MessageInput,
  SendOptions,
  PinnedMessagesPage,
} from "./messages.js";
import { Permissions, permissionsFor } from "./permissions.js";
import { snapshot } from "./snapshot.js";
import type { RESTClient } from "./rest.js";
import type { components, OperationOptions, RequestOptions } from "./types.js";
import type { KnownDispatch } from "./gateway-types.js";
type S = components["schemas"];
export interface ResourceOptions extends OperationOptions {}
export interface ResourceCacheOptions {
  users?: number;
  channels?: number;
  guilds?: number;
  members?: number;
  roles?: number;
  ttlMs?: number;
}
const permissionFeatures = {
  "X-Fluxer-Features": "view_channel_members_permission",
};
abstract class Resource<T> {
  readonly data: T;
  constructor(data: T) {
    this.data = snapshot(data);
  }
  toJSON(): T {
    return this.data;
  }
}
export class UserResource extends Resource<S["UserPartialResponse"]> {
  constructor(
    data: S["UserPartialResponse"],
    private readonly hub: Resources,
  ) {
    super(data);
  }
  get id(): string {
    return this.data.id;
  }
  get username(): string {
    return this.data.username;
  }
  async createDM(options: ResourceOptions = {}): Promise<Channel> {
    return this.hub.channels.wrap(
      await this.hub.rest.request("POST", "/users/@me/channels", {
        body: { recipient_id: this.id },
        ...options,
      }),
    );
  }
  async send(input: MessageInput, options: SendOptions = {}): Promise<Message> {
    return (await this.createDM(options)).send(input, options);
  }
  fetch(options?: ResourceOptions): Promise<UserResource> {
    return this.hub.users.fetch(this.id, options);
  }
}
export class Channel extends Resource<S["ChannelResponse"]> {
  constructor(
    data: S["ChannelResponse"],
    private readonly hub: Resources,
  ) {
    super(data);
  }
  get id(): string {
    return this.data.id;
  }
  get guildId(): string | null {
    return this.data.guild_id ?? null;
  }
  get type(): number {
    return this.data.type;
  }
  get name(): string | null {
    return this.data.name ?? null;
  }
  get guild(): Guild | undefined {
    return this.guildId ? this.hub.guilds.cache.get(this.guildId) : undefined;
  }
  send(input: MessageInput, options?: SendOptions): Promise<Message> {
    return this.hub.messages.send(this.id, input, options);
  }
  messages(
    query?: Parameters<Messages["list"]>[1],
    options?: ResourceOptions,
  ): Promise<Message[]> {
    return this.hub.messages.list(this.id, query, options);
  }
  history(
    options?: Parameters<Messages["history"]>[1],
  ): AsyncGenerator<Message> {
    return this.hub.messages.history(this.id, options);
  }
  pins(
    query: NonNullable<
      RequestOptions<"GET", "/channels/{channel_id}/messages/pins">["query"]
    > = {},
    options: ResourceOptions = {},
  ): Promise<PinnedMessagesPage> {
    return this.hub.messages.pins(this.id, query, options);
  }
  bulkDelete(
    messageIds: readonly string[],
    options: ResourceOptions = {},
  ): Promise<void> {
    return this.hub.messages.bulkDelete(this.id, messageIds, options);
  }
  async webhooks(options: ResourceOptions = {}): Promise<Webhook[]> {
    return (
      await this.hub.rest.request("GET", "/channels/{channel_id}/webhooks", {
        params: { channel_id: this.id },
        ...options,
      })
    ).map((data) => new Webhook(data, this.hub));
  }
  fetch(options?: ResourceOptions): Promise<Channel> {
    return this.hub.channels.fetch(this.id, options);
  }
  async edit(
    body: S["ChannelUpdateRequestBody"],
    options: ResourceOptions = {},
  ): Promise<Channel> {
    return this.hub.channels.wrap(
      await this.hub.rest.request("PATCH", "/channels/{channel_id}", {
        params: { channel_id: this.id },
        body,
        ...options,
      }),
    );
  }
  async delete(options: ResourceOptions = {}): Promise<void> {
    await this.hub.rest.request("DELETE", "/channels/{channel_id}", {
      params: { channel_id: this.id },
      ...options,
    });
    this.hub.channels.cache.delete(this.id);
  }
  typing(options: ResourceOptions = {}): Promise<void> {
    return this.hub.rest.request("POST", "/channels/{channel_id}/typing", {
      params: { channel_id: this.id },
      ...options,
    });
  }
  permissionsFor(
    member: GuildMember,
    roles: readonly Role[],
    ownerId: string,
  ): Permissions {
    if (!this.guildId || member.guildId !== this.guildId)
      throw new TypeError("Member and channel must belong to the same guild");
    return permissionsFor({
      guildId: this.guildId,
      ownerId,
      member: member.data,
      roles: roles.map((r) => r.data),
      overwrites: this.data.permission_overwrites ?? [],
    });
  }
  setOverwrite(
    id: string,
    body: S["PermissionOverwriteCreateRequest"],
    options: ResourceOptions = {},
  ): Promise<void> {
    return this.hub.rest.request(
      "PUT",
      "/channels/{channel_id}/permissions/{overwrite_id}",
      {
        params: { channel_id: this.id, overwrite_id: id },
        body,
        headers: permissionFeatures,
        ...options,
      },
    );
  }
  deleteOverwrite(id: string, options: ResourceOptions = {}): Promise<void> {
    return this.hub.rest.request(
      "DELETE",
      "/channels/{channel_id}/permissions/{overwrite_id}",
      {
        params: { channel_id: this.id, overwrite_id: id },
        headers: permissionFeatures,
        ...options,
      },
    );
  }
  createInvite(
    body: S["ChannelInviteCreateRequest"] = {},
    options: ResourceOptions = {},
  ): Promise<S["InviteMetadataResponseSchema"]> {
    return this.hub.rest.request("POST", "/channels/{channel_id}/invites", {
      params: { channel_id: this.id },
      body,
      ...options,
    });
  }
  invites(
    options: ResourceOptions = {},
  ): Promise<S["InviteMetadataListResponse"]> {
    return this.hub.rest.request("GET", "/channels/{channel_id}/invites", {
      params: { channel_id: this.id },
      ...options,
    });
  }
  async createWebhook(
    body: S["WebhookCreateRequest"],
    options: ResourceOptions = {},
  ): Promise<Webhook> {
    return new Webhook(
      await this.hub.rest.request("POST", "/channels/{channel_id}/webhooks", {
        params: { channel_id: this.id },
        body,
        ...options,
      }),
      this.hub,
    );
  }
}
export class Guild extends Resource<S["GuildResponse"]> {
  constructor(
    data: S["GuildResponse"],
    private readonly hub: Resources,
  ) {
    super(data);
  }
  get id(): string {
    return this.data.id;
  }
  get name(): string {
    return this.data.name;
  }
  get ownerId(): string {
    return this.data.owner_id;
  }
  get roles(): Roles {
    return new Roles(this.hub, this.id);
  }
  get members(): Members {
    return new Members(this.hub, this.id);
  }
  fetch(options?: ResourceOptions): Promise<Guild> {
    return this.hub.guilds.fetch(this.id, options);
  }
  async channels(options: ResourceOptions = {}): Promise<Channel[]> {
    return (
      await this.hub.rest.request("GET", "/guilds/{guild_id}/channels", {
        params: { guild_id: this.id },
        ...options,
      })
    ).map((d) => this.hub.channels.wrap(d));
  }
  async createChannel(
    body: S["ChannelCreateRequest"],
    options: ResourceOptions = {},
  ): Promise<Channel> {
    return this.hub.channels.wrap(
      await this.hub.rest.request("POST", "/guilds/{guild_id}/channels", {
        params: { guild_id: this.id },
        body,
        ...options,
      }),
    );
  }
  async edit(
    body: S["GuildUpdateRequest"],
    options: ResourceOptions = {},
  ): Promise<Guild> {
    return this.hub.guilds.wrap(
      await this.hub.rest.request("PATCH", "/guilds/{guild_id}", {
        params: { guild_id: this.id },
        body,
        ...options,
      }),
    );
  }
  permissionsFor(member: GuildMember, roles: readonly Role[]): Permissions {
    if (member.guildId !== this.id)
      throw new TypeError("Member belongs to a different guild");
    return permissionsFor({
      guildId: this.id,
      ownerId: this.ownerId,
      member: member.data,
      roles: roles.map((r) => r.data),
    });
  }
  ban(
    userId: string,
    body: S["GuildBanCreateRequest"] = {},
    options: ResourceOptions = {},
  ): Promise<void> {
    return this.hub.rest.request("PUT", "/guilds/{guild_id}/bans/{user_id}", {
      params: { guild_id: this.id, user_id: userId },
      body,
      ...options,
    });
  }
  unban(userId: string, options: ResourceOptions = {}): Promise<void> {
    return this.hub.rest.request(
      "DELETE",
      "/guilds/{guild_id}/bans/{user_id}",
      { params: { guild_id: this.id, user_id: userId }, ...options },
    );
  }
  bans(options: ResourceOptions = {}): Promise<S["GuildBanListResponse"]> {
    return this.hub.rest.request("GET", "/guilds/{guild_id}/bans", {
      params: { guild_id: this.id },
      ...options,
    });
  }
  auditLogs(
    query: NonNullable<
      RequestOptions<"GET", "/guilds/{guild_id}/audit-logs">["query"]
    > = {},
    options: ResourceOptions = {},
  ): Promise<S["GuildAuditLogListResponse"]> {
    return this.hub.rest.request("GET", "/guilds/{guild_id}/audit-logs", {
      params: { guild_id: this.id },
      query,
      ...options,
    });
  }
  emojis(
    options: ResourceOptions = {},
  ): Promise<S["GuildEmojiWithUserListResponse"]> {
    return this.hub.rest.request("GET", "/guilds/{guild_id}/emojis", {
      params: { guild_id: this.id },
      ...options,
    });
  }
  stickers(
    options: ResourceOptions = {},
  ): Promise<S["GuildStickerWithUserListResponse"]> {
    return this.hub.rest.request("GET", "/guilds/{guild_id}/stickers", {
      params: { guild_id: this.id },
      ...options,
    });
  }
  invites(
    options: ResourceOptions = {},
  ): Promise<S["InviteMetadataListResponse"]> {
    return this.hub.rest.request("GET", "/guilds/{guild_id}/invites", {
      params: { guild_id: this.id },
      ...options,
    });
  }
}
export class GuildMember extends Resource<S["GuildMemberResponse"]> {
  constructor(
    readonly guildId: string,
    data: S["GuildMemberResponse"],
    private readonly hub: Resources,
  ) {
    super(data);
  }
  get id(): string {
    return this.data.user.id;
  }
  get user(): UserResource {
    return this.hub.users.wrap(this.data.user);
  }
  get displayName(): string {
    return (
      this.data.nick ?? this.data.user.global_name ?? this.data.user.username
    );
  }
  fetch(options?: ResourceOptions): Promise<GuildMember> {
    return new Members(this.hub, this.guildId).fetch(this.id, options);
  }
  async edit(
    body: S["GuildMemberUpdateRequest"],
    options: ResourceOptions = {},
  ): Promise<GuildMember> {
    return this.hub.wrapMember(
      this.guildId,
      await this.hub.rest.request(
        "PATCH",
        "/guilds/{guild_id}/members/{user_id}",
        {
          params: { guild_id: this.guildId, user_id: this.id },
          body,
          ...options,
        },
      ),
    );
  }
  async kick(options: ResourceOptions = {}): Promise<void> {
    await this.hub.rest.request(
      "DELETE",
      "/guilds/{guild_id}/members/{user_id}",
      { params: { guild_id: this.guildId, user_id: this.id }, ...options },
    );
    this.hub.memberCache.delete(`${this.guildId}:${this.id}`);
  }
  addRole(roleId: string, options: ResourceOptions = {}): Promise<void> {
    return this.hub.rest.request(
      "PUT",
      "/guilds/{guild_id}/members/{user_id}/roles/{role_id}",
      {
        params: { guild_id: this.guildId, user_id: this.id, role_id: roleId },
        ...options,
      },
    );
  }
  removeRole(roleId: string, options: ResourceOptions = {}): Promise<void> {
    return this.hub.rest.request(
      "DELETE",
      "/guilds/{guild_id}/members/{user_id}/roles/{role_id}",
      {
        params: { guild_id: this.guildId, user_id: this.id, role_id: roleId },
        ...options,
      },
    );
  }
  timeout(
    until: Date | null,
    options: ResourceOptions = {},
  ): Promise<GuildMember> {
    return this.edit(
      { communication_disabled_until: until?.toISOString() ?? null },
      options,
    );
  }
}
export class Role extends Resource<S["GuildRoleResponse"]> {
  constructor(
    readonly guildId: string,
    data: S["GuildRoleResponse"],
    private readonly hub: Resources,
  ) {
    super(data);
  }
  get id(): string {
    return this.data.id;
  }
  get name(): string {
    return this.data.name;
  }
  get permissions(): Permissions {
    return new Permissions(this.data.permissions);
  }
  async edit(
    body: S["GuildRoleUpdateRequest"],
    options: ResourceOptions = {},
  ): Promise<Role> {
    return this.hub.wrapRole(
      this.guildId,
      await this.hub.rest.request(
        "PATCH",
        "/guilds/{guild_id}/roles/{role_id}",
        {
          params: { guild_id: this.guildId, role_id: this.id },
          body,
          headers: permissionFeatures,
          ...options,
        },
      ),
    );
  }
  async delete(options: ResourceOptions = {}): Promise<void> {
    await this.hub.rest.request(
      "DELETE",
      "/guilds/{guild_id}/roles/{role_id}",
      { params: { guild_id: this.guildId, role_id: this.id }, ...options },
    );
    this.hub.roleCache.delete(`${this.guildId}:${this.id}`);
  }
}
export class Users {
  readonly cache: LRUCache<string, UserResource>;
  constructor(
    private readonly hub: Resources,
    options: ResourceCacheOptions,
  ) {
    this.cache = new LRUCache(options.users ?? 0, options.ttlMs ?? 300000);
  }
  wrap(data: S["UserPartialResponse"]): UserResource {
    const value = new UserResource(data, this.hub);
    this.cache.set(value.id, value);
    return value;
  }
  async fetch(
    id: string,
    options: ResourceOptions = {},
  ): Promise<UserResource> {
    return this.wrap(
      await this.hub.rest.request("GET", "/users/{user_id}", {
        params: { user_id: id },
        ...options,
      }),
    );
  }
}
export class Channels {
  readonly cache: LRUCache<string, Channel>;
  constructor(
    private readonly hub: Resources,
    options: ResourceCacheOptions,
  ) {
    this.cache = new LRUCache(options.channels ?? 0, options.ttlMs ?? 300000);
  }
  wrap(data: S["ChannelResponse"]): Channel {
    const value = new Channel(data, this.hub);
    this.cache.set(value.id, value);
    return value;
  }
  async fetch(id: string, options: ResourceOptions = {}): Promise<Channel> {
    return this.wrap(
      await this.hub.rest.request("GET", "/channels/{channel_id}", {
        params: { channel_id: id },
        ...options,
      }),
    );
  }
}
export class Guilds {
  readonly cache: LRUCache<string, Guild>;
  constructor(
    private readonly hub: Resources,
    options: ResourceCacheOptions,
  ) {
    this.cache = new LRUCache(options.guilds ?? 0, options.ttlMs ?? 300000);
  }
  wrap(data: S["GuildResponse"]): Guild {
    const value = new Guild(data, this.hub);
    this.cache.set(value.id, value);
    return value;
  }
  async fetch(id: string, options: ResourceOptions = {}): Promise<Guild> {
    return this.wrap(
      await this.hub.rest.request("GET", "/guilds/{guild_id}", {
        params: { guild_id: id },
        ...options,
      }),
    );
  }
  async list(options: ResourceOptions = {}): Promise<Guild[]> {
    return (
      await this.hub.rest.request("GET", "/users/@me/guilds", options)
    ).map((d) => this.wrap(d));
  }
}
export class Members {
  constructor(
    private readonly hub: Resources,
    readonly guildId: string,
  ) {}
  async fetch(id: string, options: ResourceOptions = {}): Promise<GuildMember> {
    return this.hub.wrapMember(
      this.guildId,
      await this.hub.rest.request(
        "GET",
        "/guilds/{guild_id}/members/{user_id}",
        { params: { guild_id: this.guildId, user_id: id }, ...options },
      ),
    );
  }
  async list(
    query: { limit?: number; after?: string } = {},
    options: ResourceOptions = {},
  ): Promise<GuildMember[]> {
    return (
      await this.hub.rest.request("GET", "/guilds/{guild_id}/members", {
        params: { guild_id: this.guildId },
        query,
        ...options,
      })
    ).map((d) => this.hub.wrapMember(this.guildId, d));
  }
  async *iterate(
    options: ResourceOptions & { limit?: number } = {},
  ): AsyncGenerator<GuildMember> {
    const { limit: _, ...control } = options;
    let after: string | undefined,
      count = 0;
    const limit = options.limit ?? Infinity;
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0))
      throw new RangeError("limit must be non-negative");
    while (count < limit) {
      options.signal?.throwIfAborted();
      const size = Math.min(1000, limit - count);
      const page = await this.list(
        { limit: size, ...(after ? { after } : {}) },
        control,
      );
      for (const member of page) {
        options.signal?.throwIfAborted();
        if (count >= limit) return;
        count++;
        yield member;
      }
      const next = page.at(-1)?.id;
      if (page.length < size || !next || next === after) return;
      after = next;
    }
  }
}
export class Roles {
  constructor(
    private readonly hub: Resources,
    readonly guildId: string,
  ) {}
  async list(options: ResourceOptions = {}): Promise<Role[]> {
    return (
      await this.hub.rest.request("GET", "/guilds/{guild_id}/roles", {
        params: { guild_id: this.guildId },
        ...options,
      })
    ).map((d) => this.hub.wrapRole(this.guildId, d));
  }
  async create(
    body: S["GuildRoleCreateRequest"],
    options: ResourceOptions = {},
  ): Promise<Role> {
    return this.hub.wrapRole(
      this.guildId,
      await this.hub.rest.request("POST", "/guilds/{guild_id}/roles", {
        params: { guild_id: this.guildId },
        body,
        headers: permissionFeatures,
        ...options,
      }),
    );
  }
  setPositions(
    body: S["GuildRolePositionsRequest"],
    options: ResourceOptions = {},
  ): Promise<void> {
    return this.hub.rest.request("PATCH", "/guilds/{guild_id}/roles", {
      params: { guild_id: this.guildId },
      body,
      ...options,
    });
  }
}
export class Invites {
  constructor(private readonly hub: Resources) {}
  fetch(
    code: string,
    options: ResourceOptions = {},
  ): Promise<S["InviteResponseSchema"]> {
    return this.hub.rest.request("GET", "/invites/{invite_code}", {
      params: { invite_code: code },
      ...options,
    });
  }
  delete(code: string, options: ResourceOptions = {}): Promise<void> {
    return this.hub.rest.request("DELETE", "/invites/{invite_code}", {
      params: { invite_code: code },
      ...options,
    });
  }
}
/** Bot-authenticated webhook management. Execution tokens are supplied explicitly. */
export class Webhook extends Resource<Omit<S["WebhookResponse"], "token">> {
  #token: string | undefined;
  constructor(
    data: S["WebhookResponse"],
    private readonly hub: Resources,
  ) {
    const { token, ...safe } = data;
    super(safe);
    this.#token = token;
  }
  get id(): string {
    return this.data.id;
  }
  execute(
    body: S["WebhookMessageRequest"],
    options: SendOptions = {},
  ): Promise<Message> {
    if (!this.#token) throw new Error("This webhook has no execution token");
    return this.hub.webhooks.execute(this.id, this.#token, body, options);
  }
  async fetchMessage(
    messageId: string,
    options: ResourceOptions = {},
  ): Promise<Message> {
    if (!this.#token) throw new Error("This webhook has no execution token");
    return this.hub.messages.wrap(
      await this.hub.rest.request(
        "GET",
        "/webhooks/{webhook_id}/{token}/messages/{message_id}",
        {
          params: {
            webhook_id: this.id,
            token: this.#token,
            message_id: messageId,
          },
          ...options,
        },
      ),
    );
  }
  async editMessage(
    messageId: string,
    body: S["WebhookMessageEditRequest"],
    options: SendOptions = {},
  ): Promise<Message> {
    if (!this.#token) throw new Error("This webhook has no execution token");
    const { multipart } = await import("./messages.js");
    const { files, ...control } = options;
    return this.hub.messages.wrap(
      await this.hub.rest.request(
        "PATCH",
        "/webhooks/{webhook_id}/{token}/messages/{message_id}",
        {
          params: {
            webhook_id: this.id,
            token: this.#token,
            message_id: messageId,
          },
          body: files?.length ? multipart(body, files) : body,
          ...control,
        },
      ),
    );
  }
  deleteMessage(
    messageId: string,
    options: ResourceOptions = {},
  ): Promise<void> {
    if (!this.#token) throw new Error("This webhook has no execution token");
    return this.hub.rest.request(
      "DELETE",
      "/webhooks/{webhook_id}/{token}/messages/{message_id}",
      {
        params: {
          webhook_id: this.id,
          token: this.#token,
          message_id: messageId,
        },
        ...options,
      },
    );
  }
  async edit(
    body: S["WebhookUpdateRequest"],
    options: ResourceOptions = {},
  ): Promise<Webhook> {
    return new Webhook(
      await this.hub.rest.request("PATCH", "/webhooks/{webhook_id}", {
        params: { webhook_id: this.id },
        body,
        ...options,
      }),
      this.hub,
    );
  }
  delete(options: ResourceOptions = {}): Promise<void> {
    return this.hub.rest.request("DELETE", "/webhooks/{webhook_id}", {
      params: { webhook_id: this.id },
      ...options,
    });
  }
}
export class Webhooks {
  constructor(private readonly hub: Resources) {}
  async fetch(id: string, options: ResourceOptions = {}): Promise<Webhook> {
    return new Webhook(
      await this.hub.rest.request("GET", "/webhooks/{webhook_id}", {
        params: { webhook_id: id },
        ...options,
      }),
      this.hub,
    );
  }
  async execute(
    id: string,
    token: string,
    body: S["WebhookMessageRequest"],
    options: SendOptions = {},
  ): Promise<Message> {
    const { multipart } = await import("./messages.js");
    const { files, ...control } = options;
    return this.hub.messages.wrap(
      await this.hub.rest.request("POST", "/webhooks/{webhook_id}/{token}", {
        params: { webhook_id: id, token },
        query: { wait: "true" },
        body: files?.length ? multipart(body, files) : body,
        ...control,
      }),
    );
  }
}
/** Shared, bounded caches; scoped managers never allocate additional stores. */
export class Resources {
  readonly users: Users;
  readonly channels: Channels;
  readonly guilds: Guilds;
  readonly invites: Invites;
  readonly webhooks: Webhooks;
  readonly messages: Messages;
  readonly memberCache: LRUCache<string, GuildMember>;
  readonly roleCache: LRUCache<string, Role>;
  get rest(): RESTClient {
    return this.getREST();
  }
  constructor(
    private readonly getREST: () => RESTClient,
    options: ResourceCacheOptions = {},
  ) {
    this.users = new Users(this, options);
    this.channels = new Channels(this, options);
    this.guilds = new Guilds(this, options);
    this.invites = new Invites(this);
    this.webhooks = new Webhooks(this);
    this.messages = new Messages(this.rest);
    this.memberCache = new LRUCache(
      options.members ?? 0,
      options.ttlMs ?? 300000,
    );
    this.roleCache = new LRUCache(options.roles ?? 0, options.ttlMs ?? 300000);
  }
  wrapMember(guildId: string, data: S["GuildMemberResponse"]): GuildMember {
    const value = new GuildMember(guildId, data, this);
    this.memberCache.set(`${guildId}:${value.id}`, value);
    if (this.users.cache.maxSize > 0) this.users.wrap(data.user);
    return value;
  }
  wrapRole(guildId: string, data: S["GuildRoleResponse"]): Role {
    const value = new Role(guildId, data, this);
    this.roleCache.set(`${guildId}:${value.id}`, value);
    return value;
  }
  clear(): void {
    this.users.cache.clear();
    this.channels.cache.clear();
    this.guilds.cache.clear();
    this.memberCache.clear();
    this.roleCache.clear();
  }
  apply(event: KnownDispatch): void {
    const users = this.users.cache.maxSize > 0;
    const channels = this.channels.cache.maxSize > 0;
    const guilds = this.guilds.cache.maxSize > 0;
    const members = this.memberCache.maxSize > 0;
    const roles = this.roleCache.maxSize > 0;
    if (!users && !channels && !guilds && !members && !roles) return;
    switch (event.t) {
      case "READY":
        this.clear();
        if (users) {
          this.users.wrap(event.d.user);
          for (const u of event.d.users ?? []) this.users.wrap(u);
        }
        if (channels)
          for (const c of event.d.private_channels ?? []) this.channels.wrap(c);
        for (const g of event.d.guilds ?? [])
          if (!g.unavailable)
            this.apply({ op: 0, t: "GUILD_CREATE", s: event.s, d: g });
        break;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
        if (channels) this.channels.wrap(event.d);
        break;
      case "CHANNEL_UPDATE_BULK":
        if (channels)
          for (const c of event.d.channels) this.channels.wrap(c);
        break;
      case "CHANNEL_DELETE":
        this.channels.cache.delete(event.d.id);
        break;
      case "GUILD_CREATE":
      case "GUILD_SYNC":
        if (!event.d.unavailable) {
          if (guilds) this.guilds.wrap(event.d.properties);
          if (channels)
            for (const c of event.d.channels ?? []) this.channels.wrap(c);
          if (roles)
            for (const r of event.d.roles ?? []) this.wrapRole(event.d.id, r);
          // Reduced member payloads require explicit fetch before hydration.
        }
        break;
      case "GUILD_UPDATE":
        if (guilds) this.guilds.wrap(event.d);
        break;
      case "GUILD_DELETE":
        this.clearGuild(event.d.id);
        break;
      case "GUILD_MEMBER_ADD":
      case "GUILD_MEMBER_UPDATE":
        if (members) this.wrapMember(event.d.guild_id, event.d);
        else if (users) this.users.wrap(event.d.user);
        break;
      case "GUILD_MEMBERS_CHUNK":
        if (members)
          for (const m of event.d.members) this.wrapMember(event.d.guild_id, m);
        else if (users)
          for (const m of event.d.members) this.users.wrap(m.user);
        break;
      case "GUILD_MEMBER_REMOVE":
        this.memberCache.delete(`${event.d.guild_id}:${event.d.user.id}`);
        break;
      case "GUILD_ROLE_CREATE":
      case "GUILD_ROLE_UPDATE":
        if (roles) this.wrapRole(event.d.guild_id, event.d.role);
        break;
      case "GUILD_ROLE_UPDATE_BULK":
        if (roles)
          for (const role of event.d.roles) this.wrapRole(event.d.guild_id, role);
        break;
      case "GUILD_ROLE_DELETE":
        this.roleCache.delete(`${event.d.guild_id}:${event.d.role_id}`);
        break;
      case "USER_UPDATE":
        if (users) this.users.wrap(event.d);
        break;
    }
  }
  private clearGuild(id: string): void {
    this.guilds.cache.delete(id);
    for (const [key, value] of this.channels.cache.items())
      if (value.guildId === id) this.channels.cache.delete(key);
    for (const [key, value] of this.memberCache.items())
      if (value.guildId === id) this.memberCache.delete(key);
    for (const [key, value] of this.roleCache.items())
      if (value.guildId === id) this.roleCache.delete(key);
  }
}
