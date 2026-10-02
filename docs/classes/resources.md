# Resource objects

Import these classes from `talos-fluxer` or `talos-fluxer/resources`. Prefer
obtaining them through a manager rather than constructing API payloads yourself.
See the [resource guide](../resources.md) and [source](../../src/resources.ts).

`UserResource`, `Channel`, `Guild`, `GuildMember`, and `Role` inherit `data`, a
frozen API snapshot, and `toJSON()`, which returns that snapshot. A fetch or edit
returns a new object. REST operation options accept `signal`, `timeoutMs`, and
`reason`; message options also accept `files`.

## Resources

Available as `client.resources`. To use the helpers without a gateway, construct
`new Resources(() => rest, cacheOptions?)`. The REST client must already exist.

| Property | Value |
| --- | --- |
| `rest` | REST client supplied by the constructor callback. |
| `users`, `channels`, `guilds` | `Users`, `Channels`, and `Guilds` managers. |
| `invites`, `webhooks`, `messages` | `Invites`, `Webhooks`, and `Messages` managers. |
| `memberCache` | Member cache keyed by `guildId:userId`. |
| `roleCache` | Role cache keyed by `guildId:roleId`. |

| Method | Result and behaviour |
| --- | --- |
| `wrapMember(guildId, data)` | `GuildMember`; also stores its user in the user cache. |
| `wrapRole(guildId, data)` | `Role`; stores it in the role cache. |
| `clear()` | `void`; clears resource caches. The separate `Client.cache` message cache is not part of this hub. |
| `apply(event)` | `void`; applies a known gateway dispatch to supported resource caches. |

Cache options are `users`, `channels`, `guilds`, `members`, `roles`, and `ttlMs`.
Capacities default to zero and TTL to five minutes. Managers scoped to a guild
share these caches. `Client` calls `apply()` automatically; REST-only code receives
no gateway updates unless the application supplies them.

## UserResource

Obtain with `client.users.fetch(userId)` or `resources.users.wrap(data)`.
Constructor: `new UserResource(data, resources)`.

Properties: `id`, `username`, and inherited `data` and `toJSON()`.

| Method | Result and behaviour |
| --- | --- |
| `createDM(options?)` | `Promise<Channel>`; opens or retrieves a DM channel. |
| `send(input, options?)` | `Promise<Message>`; creates the DM channel, then sends text or a message body. |
| `fetch(options?)` | `Promise<UserResource>`; retrieves a fresh user snapshot. |

## Channel

Obtain with `client.channels.fetch(channelId)`.
Constructor: `new Channel(data, resources)`.

Properties: `id`, `guildId` (string or `null`), `type` (number), `name` (string or
`null`), `guild` (`Guild` or `undefined`), plus inherited `data` and `toJSON()`.
`guild` reads the cache only; it does not fetch.

| Method | Result and behaviour |
| --- | --- |
| `send(input, options?)` | `Promise<Message>`; sends text or a message body. |
| `messages(query?, options?)` | `Promise<Message[]>`; fetches one page. |
| `history(options?)` | `AsyncGenerator<Message>`; walks newest first. |
| `pins(query?, options?)` | `Promise<PinnedMessagesPage>`. |
| `bulkDelete(messageIds, options?)` | `Promise<void>`; requires 1–100 unique IDs. |
| `webhooks(options?)` | `Promise<Webhook[]>`; lists this channel's webhooks. |
| `fetch(options?)` | `Promise<Channel>`; refreshes through REST. |
| `edit(body, options?)` | `Promise<Channel>`; uses `ChannelUpdateRequestBody`. |
| `delete(options?)` | `Promise<void>`; deletes the channel and removes its cached entry. |
| `typing(options?)` | `Promise<void>`; sends the typing indicator. |
| `permissionsFor(member, roles, ownerId)` | `Permissions`; combines guild roles with channel overwrites. |
| `setOverwrite(id, body, options?)` | `Promise<void>`; uses `PermissionOverwriteCreateRequest`. |
| `deleteOverwrite(id, options?)` | `Promise<void>`. |
| `createInvite(body?, options?)` | Promise of `InviteMetadataResponseSchema`; body defaults to `{}`. |
| `invites(options?)` | Promise of `InviteMetadataListResponse`. |
| `createWebhook(body, options?)` | `Promise<Webhook>`; uses `WebhookCreateRequest`. |

History and send options match the [Messages manager](messages.md#messages).
Permission calculation requires a member from this channel's guild and the full
role list. Direct-message channels have no guild permission mask to calculate.

## Guild

Obtain with `client.guilds.fetch(guildId)`.
Constructor: `new Guild(data, resources)`.

Properties: `id`, `name`, `ownerId`, `roles` (`Roles` manager), `members` (`Members`
manager), and inherited `data` and `toJSON()`.

| Method | Result and behaviour |
| --- | --- |
| `fetch(options?)` | `Promise<Guild>`. |
| `channels(options?)` | `Promise<Channel[]>`. |
| `createChannel(body, options?)` | `Promise<Channel>`; uses `ChannelCreateRequest`. |
| `edit(body, options?)` | `Promise<Guild>`; uses `GuildUpdateRequest`. |
| `permissionsFor(member, roles)` | `Permissions`; calculates guild permissions without channel overwrites. |
| `ban(userId, body?, options?)` | `Promise<void>`; uses `GuildBanCreateRequest`, defaulting to `{}`. |
| `unban(userId, options?)` | `Promise<void>`. |
| `bans(options?)` | Promise of `GuildBanListResponse`. |
| `auditLogs(query?, options?)` | Promise of `GuildAuditLogListResponse`. |
| `emojis(options?)` | Promise of `GuildEmojiWithUserListResponse`. |
| `stickers(options?)` | Promise of `GuildStickerWithUserListResponse`. |
| `invites(options?)` | Promise of `InviteMetadataListResponse`. |

The member passed to `permissionsFor()` must belong to this guild. Use
`Channel.permissionsFor()` when channel overwrites matter.

## GuildMember

Obtain with `guild.members.fetch(userId)`.
Constructor: `new GuildMember(guildId, data, resources)`.

Properties: `guildId`, `id` (the user ID), `user` (`UserResource`), `displayName`,
and inherited `data` and `toJSON()`. The display name uses nickname, then global
name, then username.

| Method | Result and behaviour |
| --- | --- |
| `fetch(options?)` | `Promise<GuildMember>`. |
| `edit(body, options?)` | `Promise<GuildMember>`; uses `GuildMemberUpdateRequest`. |
| `kick(options?)` | `Promise<void>`; removes the member and its cached entry. |
| `addRole(roleId, options?)` | `Promise<void>`. |
| `removeRole(roleId, options?)` | `Promise<void>`. |
| `timeout(until, options?)` | `Promise<GuildMember>`; accepts a `Date` or `null` to clear the timeout. |

Role changes do not mutate this snapshot. Fetch again when you need the updated
role list. The server enforces moderation permissions and role hierarchy.

## Role

Obtain from `guild.roles.list()` or `guild.roles.create(body)`.
Constructor: `new Role(guildId, data, resources)`.

Properties: `guildId`, `id`, `name`, `permissions` (`Permissions`), and inherited
`data` and `toJSON()`.

| Method | Result and behaviour |
| --- | --- |
| `edit(body, options?)` | `Promise<Role>`; uses `GuildRoleUpdateRequest`. |
| `delete(options?)` | `Promise<void>`; removes the role and its cached entry. |

Use `Permissions.toRequest()` when writing permission masks into role requests.
