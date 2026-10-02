# Resource managers

Import these classes from `talos-fluxer` or `talos-fluxer/resources`. `Client` and
`Resources` create the usual managers for you. Constructors take a `Resources`
hub; guild-scoped managers also take a guild ID.

All `fetch()` methods request fresh API data. A cache lookup is explicit.
Options accept `signal`, `timeoutMs`, and `reason`. See
[the source](../../src/resources.ts) and [cache usage](../resources.md#enable-caches-when-you-need-them).

## Users

Available as `client.users` or `resources.users`.
Constructor: `new Users(resources, cacheOptions)`; pass `{}` for defaults.

| Member | Result and behaviour |
| --- | --- |
| `cache` | `LRUCache<string, UserResource>`, keyed by user ID. |
| `wrap(data)` | `UserResource`; stores the supplied user snapshot if caching is enabled. |
| `fetch(id, options?)` | `Promise<UserResource>`; requests and wraps one user. |

## Channels

Available as `client.channels` or `resources.channels`.
Constructor: `new Channels(resources, cacheOptions)`.

| Member | Result and behaviour |
| --- | --- |
| `cache` | `LRUCache<string, Channel>`, keyed by channel ID. |
| `wrap(data)` | `Channel`; stores the supplied channel snapshot if caching is enabled. |
| `fetch(id, options?)` | `Promise<Channel>`; requests and wraps one channel. |

## Guilds

Available as `client.guilds` or `resources.guilds`.
Constructor: `new Guilds(resources, cacheOptions)`.

| Member | Result and behaviour |
| --- | --- |
| `cache` | `LRUCache<string, Guild>`, keyed by guild ID. |
| `wrap(data)` | `Guild`; stores the supplied snapshot if caching is enabled. |
| `fetch(id, options?)` | `Promise<Guild>`; requests and wraps one guild. |
| `list(options?)` | `Promise<Guild[]>`; lists the current user's guilds. |

`wrap()` expects the guild response shape, not the larger gateway guild-ready
envelope. `Resources.apply()` handles supported gateway envelopes.

## Members

Available as `guild.members`. Constructor: `new Members(resources, guildId)`.

| Member | Result and behaviour |
| --- | --- |
| `guildId` | Guild this manager operates on. |
| `fetch(id, options?)` | `Promise<GuildMember>`; uses the member's user ID. |
| `list({ limit?, after? }?, options?)` | `Promise<GuildMember[]>`; fetches one page, with a numeric page limit. |
| `iterate(options?)` | `AsyncGenerator<GuildMember>`; accepts operation options and a numeric total `limit`. |

The iterator requests up to 1,000 members per page and stops when you leave the
loop. Omitting the total limit walks all available pages. Members share
`resources.memberCache`; this manager does not allocate its own cache.

## Roles

Available as `guild.roles`. Constructor: `new Roles(resources, guildId)`.

| Member | Result and behaviour |
| --- | --- |
| `guildId` | Guild this manager operates on. |
| `list(options?)` | `Promise<Role[]>`. |
| `create(body, options?)` | `Promise<Role>`; uses `GuildRoleCreateRequest`. |
| `setPositions(body, options?)` | `Promise<void>`; uses `GuildRolePositionsRequest` to reorder roles. |

Returned roles are stored in the hub's role cache when it is enabled. Role
permission fields are decimal strings; use `Permissions.toRequest()`.

## Invites

Available as `client.invites` or `resources.invites`.
Constructor: `new Invites(resources)`.

| Method | Result and behaviour |
| --- | --- |
| `fetch(code, options?)` | Promise of `InviteResponseSchema`; looks up an invite code. |
| `delete(code, options?)` | `Promise<void>`; revokes the invite. |

Pass the invite code, not the full URL. These methods return raw API data rather
than an invite wrapper class. Create or list channel invites through `Channel`;
list guild invites through `Guild`.
