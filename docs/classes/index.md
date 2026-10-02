# Class reference

This reference covers all 35 classes exported by the package. Each entry explains
how to obtain an instance, its properties, and its methods. The four implementation
classes are documented separately under [internals](internals.md).

| Class | Purpose | Import from |
| --- | --- | --- |
| [Client](clients.md#client) | Bot lifecycle, resources, and events | `talos-fluxer` |
| [RESTClient](clients.md#restclient) | Typed API requests | `talos-fluxer` or `/rest` |
| [GatewayClient](clients.md#gatewayclient) | WebSocket protocol and recovery | `talos-fluxer` or `/gateway` |
| [Message](messages.md#message) | One message and actions on it | `talos-fluxer` |
| [Messages](messages.md#messages) | Sending, fetching, and history | `talos-fluxer` |
| [Uploads](messages.md#uploads) | Separate attachment upload flow | `talos-fluxer` or `/uploads` |
| [Resources](resources.md#resources) | Shared resource managers and caches | `talos-fluxer` or `/resources` |
| [UserResource](resources.md#userresource) | User snapshot and DMs | `talos-fluxer` or `/resources` |
| [Channel](resources.md#channel) | Channel snapshot and operations | `talos-fluxer` or `/resources` |
| [Guild](resources.md#guild) | Guild snapshot and operations | `talos-fluxer` or `/resources` |
| [GuildMember](resources.md#guildmember) | Member snapshot and moderation | `talos-fluxer` or `/resources` |
| [Role](resources.md#role) | Role snapshot and editing | `talos-fluxer` or `/resources` |
| [Users](managers.md#users) | User fetching and cache | `talos-fluxer` or `/resources` |
| [Channels](managers.md#channels) | Channel fetching and cache | `talos-fluxer` or `/resources` |
| [Guilds](managers.md#guilds) | Guild fetching, listing, and cache | `talos-fluxer` or `/resources` |
| [Members](managers.md#members) | Member fetching and pagination | `talos-fluxer` or `/resources` |
| [Roles](managers.md#roles) | Role listing, creation, and ordering | `talos-fluxer` or `/resources` |
| [Invites](managers.md#invites) | Invite lookup and deletion | `talos-fluxer` or `/resources` |
| [Webhook](webhooks.md#webhook) | Webhook management and message operations | `talos-fluxer` or `/resources` |
| [Webhooks](webhooks.md#webhooks) | Webhook fetching and token-based execution | `talos-fluxer` or `/resources` |
| [Permissions](utilities.md#permissions) | Permission bit masks | `talos-fluxer` or `/permissions` |
| [LRUCache](utilities.md#lrucache) | Bounded cache with expiration | `talos-fluxer` |
| [MemoryRateLimitStore](rate-limits.md#memoryratelimitstore) | Rate-limit coordination in one process | `talos-fluxer` or `/rate-limits` |
| [IPCRateLimitStore](rate-limits.md#ipcratelimitstore) | Rate-limit coordination through Node message ports | `talos-fluxer/node` |
| [IdentifyLimiter](shards-workers.md#identifylimiter) | Gate gateway Identify attempts | `talos-fluxer/shards` |
| [ShardManager](shards-workers.md#shardmanager) | Start and stop shard clients | `talos-fluxer/shards` |
| [WorkerSupervisor](shards-workers.md#workersupervisor) | Start workers and restart after exits | `talos-fluxer/supervisor` |
| [VoiceConnection](voice.md#voiceconnection) | One voice transport | `talos-fluxer/voice` |
| [VoiceSession](voice.md#voicesession) | Voice connection with automatic rejoining | `talos-fluxer/voice` |
| [VoicePlayer](voice.md#voiceplayer) | Queued browser audio playback | `talos-fluxer/voice` |
| [FluxerAPIError](errors.md#fluxerapierror) | Unsuccessful API response | `talos-fluxer` or `/rest` |
| [GatewayError](errors.md#gatewayerror) | Gateway protocol or lifecycle failure | `talos-fluxer` or `/gateway` |
| [RequestQueueFullError](errors.md#requestqueuefullerror) | REST pending capacity exceeded | `talos-fluxer` or `/rest` |
| [UploadError](errors.md#uploaderror) | Upload plan or transfer failure | `talos-fluxer` or `/uploads` |
| [VoiceLifecycleError](errors.md#voicelifecycleerror) | Signaling interrupted a pending voice join | `talos-fluxer/voice` |

In the import column, `/rest` means `talos-fluxer/rest`, and the other shortened
subpaths work the same way. Voice, shards, workers, and Node adapters require
their listed subpaths; they are not re-exported from the main entry point.

## Reading the method tables

`options?` means optional. For REST-backed operations it generally accepts
`signal`, `timeoutMs`, and `reason`; message sends and edits also accept `files`.
Request bodies and query objects use the bundled API schema. Follow each page's
source link or use editor completion for the exact fields.

Event-emitting classes also expose `on()`, `once()`, `emit()`, and
`removeAllListeners()`. These inherited methods are described under
[TypedEmitter](internals.md#typedemitter). Resource snapshots inherit `data` and
`toJSON()` from [Resource](internals.md#resource).

Start with the [command-bot guide](../guide.md) for a complete program, or return
to the [docs index](../index.md) for task-specific examples.
