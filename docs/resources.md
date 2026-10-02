# Resources and permissions

Resource helpers wrap API responses with methods such as `channel.send()` and
`guild.members.fetch()`. They use the same REST client, queues, and rate limits as
`client.rest.request()`.

## Fetch a resource

```ts
const channel = await client.channels.fetch(channelId);
await channel.send("Hello from Talos.");

const guild = await client.guilds.fetch(guildId);
const member = await guild.members.fetch(userId);
console.log(member.displayName);
```

Resource methods accept `signal`, `timeoutMs`, and `reason` options. `.data` holds
the frozen API response; convenience getters use camelCase, such as
`channel.guildId`, while raw fields keep their API names.

Resource objects are snapshots. A gateway update or a call to `edit()` does not
rewrite an object you already hold. Use the returned object or fetch again.

For a direct message, fetch a user and call `send()`:

```ts
const user = await client.users.fetch(userId);
await user.send("Your report is ready.");
```

This creates or retrieves the DM channel before sending. The server may reject it
because of the recipient's settings or the bot's access.

## Iterate members

```ts
const guild = await client.guilds.fetch(guildId);

for await (const member of guild.members.iterate({ limit: 2_000 })) {
  console.log(member.id, member.displayName);
}
```

The iterator fetches pages of up to 1,000 members. Without `limit`, it continues
until the API has no more pages. `guild.members.list()` fetches one page and
accepts `{ limit, after }`, with a numeric page limit.

## Enable caches when you need them

All client caches are disabled by default. Capacities count entries, and `ttlMs`
applies to each cache:

```ts
import { Client } from "talos-fluxer";

const client = new Client({
  token,
  cache: {
    messages: 500,
    users: 500,
    channels: 100,
    guilds: 20,
    members: 1_000,
    roles: 200,
    ttlMs: 300_000,
  },
});
await client.connect();
```

`fetch()` always makes an API request. To use a cached channel, check it explicitly:

```ts
const channel =
  client.channels.cache.get(channelId) ??
  (await client.channels.fetch(channelId));
```

Resource caches receive fetched resources and supported gateway updates. They can
be incomplete: for example, reduced member data in guild startup payloads is not
hydrated into the member cache. `channel.guild` only reads the guild cache and may
be `undefined`; fetch the guild explicitly if you need it.

`client.cache` is the separate message cache. Keys are
`${channelId}:${messageId}`. It receives `MESSAGE_CREATE` events, merges updates
into existing entries, and removes deleted messages. Fetching or sending a message
does not populate it. A new `READY`, terminal gateway closure, or `disconnect()`
clears the client's caches; a successful Resume preserves them.

## Check channel permissions

Load the member, the guild's full role list, and the channel's overwrites before
calculating permissions:

```ts
import { PermissionFlags } from "talos-fluxer";

const [channel, guild] = await Promise.all([
  client.channels.fetch(channelId),
  client.guilds.fetch(guildId),
]);
const [member, roles] = await Promise.all([
  guild.members.fetch(userId),
  guild.roles.list(),
]);

const permissions = channel.permissionsFor(member, roles, guild.ownerId);
console.log(permissions.has(PermissionFlags.SEND_MESSAGES));
```

Use the bot's user ID to check its permissions; use a command author's ID to check
theirs. The member and channel must belong to the same guild.

This calculates the permission mask, including role and member overwrites. It does
not check every reason an operation can fail, such as a timeout, MFA requirements,
or role hierarchy. The API remains the final authority. Separate helpers such as
`isTimedOut()`, `canManageRole()`, and `canDeleteRole()` cover some of those checks.

Permission flags are `bigint` values. Use `Permissions.toRequest()` when building
a role or overwrite request; it returns a decimal string containing the defined
permission bits. Converting masks to JavaScript numbers can lose precision.

For an endpoint without a resource helper, use the [typed REST client](rest.md).
