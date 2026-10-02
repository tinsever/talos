# Talos

A portable, TypeScript-first Fluxer SDK.

Voice support includes gateway signaling, LiveKit audio publishing and receiving,
browser file playback, shared-key E2EE, and bounded automatic rejoining. Supply
`livekit-client` or a custom media adapter separately. See the [voice support
contract](VOICE.md) for runtime requirements, lifecycle guarantees, and examples.

Run `bun run check` to validate generated contracts, the public API, types, tests,
and the build.

Run `bun run bench` (Node) or `bun run bench:bun` to measure SDK processing and
local HTTP latency. See [benchmark results and optimization candidates](BENCHMARKS.md)
for measurements, reproducible commands, and experimental comparisons.
