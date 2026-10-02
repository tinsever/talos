# Permissions and LRUCache

## Permissions

Import from `talos-fluxer` or `talos-fluxer/permissions`.
`new Permissions(value?)` accepts a `bigint`, decimal string, safe non-negative
integer, or another `Permissions`. The default mask is zero. Masks must fit an
unsigned 64-bit value. See [the source](../../src/permissions.ts).

| Member | Result and behaviour |
| --- | --- |
| `bitfield` | The `bigint` mask. |
| `has(value, administrator?)` | `boolean`; checks all requested bits. The optional administrator shortcut defaults to `false`. |
| `missing(value)` | `Permissions` containing requested bits absent from this mask. |
| `add(...values)` | New `Permissions` with those bits enabled. |
| `remove(...values)` | New `Permissions` with those bits removed. |
| `names()` | Array of names from `PermissionFlags` present in the mask. |
| `toRequest()` | Decimal string containing only defined permission bits, for API requests. |
| `toJSON()` | Decimal string of the full mask. |

`add()` and `remove()` do not mutate the original. Avoid JavaScript bitwise
operations on numbers: permission masks exceed 32 bits. Combine the `bigint`
flags instead:

```ts
import { Permissions, PermissionFlags } from "talos-fluxer";

const permissions = new Permissions(
  PermissionFlags.VIEW_CHANNEL | PermissionFlags.SEND_MESSAGES,
);
console.log(permissions.names());
console.log(permissions.toRequest());
```

Related functions in the same module:

| Function | Purpose |
| --- | --- |
| `permissionsFor(input)` | Calculates guild and optional channel permissions from member, roles, owner, and overwrites. |
| `compareRoles(a, b)` | Positive if `a` outranks `b`; ties use the lower snowflake ID. |
| `highestRole(member, roles)` | Highest assigned role, or `undefined`. |
| `isTimedOut(member, now?)` | Checks `communication_disabled_until`. |
| `canManageRole(input)` | Checks role-management permission and hierarchy, with an owner shortcut. |
| `canDeleteRole(input)` | Also prevents deleting the guild's everyone role. |

See [channel permission checks](../resources.md#check-channel-permissions) for the
data you need and the policies a mask alone does not cover.

## LRUCache

Import from `talos-fluxer`. Construct
`new LRUCache<K, V>(maxSize?, ttlMs?)`. A standalone cache defaults to 100 entries
and no expiration. Client resource caches use their own defaults: disabled
capacity and a five-minute TTL. See [the source](../../src/cache.ts).

| Member | Result and behaviour |
| --- | --- |
| `maxSize` | Configured capacity; zero disables storage. |
| `ttlMs` | Configured entry lifetime. |
| `size` | Number of unexpired entries; sweeps expired entries first. |
| `get(key)` | Cached value or `undefined`; promotes an existing entry to most recently used. |
| `set(key, value)` | Returns this cache; replaces the value, resets its TTL, and evicts oldest entries if needed. |
| `items()` | Iterator of `[key, value]` after sweeping expired entries, from least to most recently used. |
| `delete(key)` | `boolean` indicating whether an entry was removed. |
| `clear()` | `void`; removes every entry. |
| `sweep()` | Number of expired entries removed. |

Expiration starts on `set()`. Reading an entry changes recency but does not
extend its TTL. There is no background expiration timer. This generic class does
not clone or freeze values; resource wrappers create their own frozen snapshots.

```ts
import { LRUCache } from "talos-fluxer";

const cache = new LRUCache<string, string>(100, 60_000);
cache.set("task:1", "finished");
console.log(cache.get("task:1"));
```
