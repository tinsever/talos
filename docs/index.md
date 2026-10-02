# Talos docs

Talos is a TypeScript SDK for Fluxer. Start with `Client` for a bot that receives
events, or `RESTClient` for scripts that only make API requests.

| Task | Guide |
| --- | --- |
| Build a bot with commands, history, and permission checks | [Command-bot guide](guide.md) |
| Run a bot and connect to an instance | [Getting started](getting-started.md) |
| Send replies, upload files, and read history | [Messages](messages.md) |
| Fetch channels and members, use caches, and check permissions | [Resources and permissions](resources.md) |
| Make API requests and handle rate limits, retries, and errors | [REST](rest.md) |
| Handle events, recover connections, and persist dispatches | [Gateway and events](gateway.md) |
| Work on the SDK and update generated types | [Contributing](development.md) |
| Join voice, publish audio, or use LiveKit | [Voice support contract](../VOICE.md) |
| Look up any class, constructor, property, or method | [Class reference](classes/index.md) |

The command-bot and getting-started guides contain complete programs. Other guides
use code fragments;
`client` means a connected `Client`, and IDs such as `channelId` are strings from
your instance.

For exact request fields, use your editor's completion or the generated
[API types](../src/generated/api.ts). The [examples directory](../examples/)
contains runnable bot, REST, resource, and worker examples.
