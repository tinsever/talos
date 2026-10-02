# Contributing

## Local setup

The repository uses Bun. `package.json` pins the package-manager version; use that
version so the lockfile format matches.

```sh
bun install --frozen-lockfile
bun run check
```

`check` verifies generated files and the public API snapshot, checks TypeScript,
runs unit tests, and builds `dist/`. It does not contact a live Fluxer instance.

For a focused test run:

```sh
bun run test tests/rest.test.ts
```

`bun run test:node` runs the unit suite under Node. The offline built-package smoke
test is `bun run smoke:node`; run `bun run build` first.

## Find the code to change

| Area | Files |
| --- | --- |
| Client lifecycle and convenience events | [src/client.ts](../src/client.ts) |
| REST requests and retry policy | [src/rest.ts](../src/rest.ts) |
| Rate-limit storage and concurrency | [src/rate-limits.ts](../src/rate-limits.ts), [src/scheduler.ts](../src/scheduler.ts) |
| WebSocket protocol and recovery | [src/gateway.ts](../src/gateway.ts) |
| Messages, resources, and permission checks | [src/messages.ts](../src/messages.ts), [src/resources.ts](../src/resources.ts), [src/permissions.ts](../src/permissions.ts) |
| Voice signaling and media adapters | [src/voice.ts](../src/voice.ts), [src/voice-livekit.ts](../src/voice-livekit.ts), [src/voice-session.ts](../src/voice-session.ts), [src/voice-player.ts](../src/voice-player.ts) |
| Public exports | [src/index.ts](../src/index.ts), [package.json](../package.json) |

Tests are in `tests/`, generally named after the module or behaviour they cover.
Core code accepts injected `fetch` and WebSocket implementations, so network
behaviour can be tested without credentials.

## Generated contracts

Do not edit `src/generated/` directly. Its inputs are:

- `schema/openapi.json`: pinned upstream API schema.
- `schema/source.json`: upstream commit and source URL.
- `schema/overrides.json`: local route authentication corrections.
- `schema/gateway-events.md`: gateway event definitions.

After changing an input, regenerate and verify:

```sh
bun run generate
bun run generate:gateway
bun run check:generated
```

To compare the pinned API schema with upstream, run `bun run schema:upstream`.
It contacts GitHub and writes `.reports/upstream.json`; it does not replace the
schema unless you pass `--update`.

To select and apply an upstream revision:

```sh
bun run schema:upstream --ref=UPSTREAM_COMMIT --update
bun run generate
bun run generate:gateway
```

Replace `UPSTREAM_COMMIT` with a commit or tag. Review the schema diff, removed or
changed operations, and local overrides before accepting an update. Add tests for
behaviour affected by the new contract.

## Public API changes

`schema/public-api.json` records the exported API. If an intentional API change
makes `check:api` fail, update the snapshot and inspect the diff:

```sh
bun run api:update
bun run check
```

Updating the snapshot records a change; it does not establish compatibility.
Check imports and types used by consumers. If you add a package subpath, update
`package.json` exports as well as the source.

## Browser and live checks

`bun run test:browser` runs the browser test-server checks and Playwright tests.
Install its browsers first:

```sh
bunx playwright install chromium firefox webkit
```

See [VOICE.md](../VOICE.md#validation-scope) for the audio backend requirement and
what these tests cover.

Build `dist/` before running the live scripts. `bun run smoke:live` discovers the
instance and checks a public REST endpoint without a token. To select another
instance, set `FLUXER_ORIGIN`.

For authenticated integration checks, copy `.env.example` to `.env` and fill in
the bot token, guild ID, channel ID, and origin. Then run:

```sh
bun run test:live
```

Use a test guild and channel: this script sends, edits, and deletes messages and
tests other API operations. Keep `.env` untracked. `bun run soak:live` monitors a
live gateway connection for 24 hours by default; set `TALOS_SOAK_MS` to change its
duration.

## Benchmarks

```sh
bun run bench
bun run bench:bun
```

The first command measures under Node; the second under Bun. These benchmarks
measure SDK processing and local HTTP latency. They do not measure Fluxer service
latency. Keep results locally in the ignored `benchmarks/` folder and compare
runs on the same machine and runtime before drawing conclusions about a change.

## Package checks

`bun run build` produces the exported JavaScript and declarations. Before a
release, create a tarball and test its installed exports:

```sh
npm pack
bun run check:package
bun run check:release
```

`npm pack` runs `prepack`, which runs the full `check`. `check:package` installs the
tarball in a temporary project, imports every package subpath under Node and Bun,
and typechecks a consumer. `check:release` verifies metadata and required files;
these commands do not publish the package.
