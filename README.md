<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/branding/talos-logo-white.svg">
  <img src="assets/branding/talos-logo.svg" alt="Talos" width="458" height="166">
</picture>

# Talos

A portable, TypeScript-first Fluxer SDK.

Run `bun run check` to validate generated contracts, the public API, types, tests,
and the build.

Run `bun run bench` (Node) or `bun run bench:bun` to measure SDK processing and
local HTTP latency. See [benchmark results and optimization candidates](BENCHMARKS.md)
for measurements, reproducible commands, and experimental comparisons.
