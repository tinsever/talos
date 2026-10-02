<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/branding/talos-logo-white.svg">
  <img src="assets/branding/talos-logo.svg" alt="Talos" width="458" height="166">
</picture>

# Talos

[![Open on npmx.dev](https://npmx.dev/api/registry/badge/version/talos-fluxer)](https://npmx.dev/package/talos-fluxer)

A portable, TypeScript-first Fluxer SDK.

Use Talos to build a Fluxer bot, make typed REST requests, or handle gateway and
voice connections. The core SDK runs on Node and Bun and has no runtime dependencies.

```sh
npm install talos-fluxer
```

Start with the [ping bot](docs/getting-started.md) or follow the
[command-bot guide](docs/guide.md). The [docs](docs/index.md) cover common tasks;
the [class reference](docs/classes/index.md) lists every class and its methods.
[Voice support](VOICE.md) covers media adapters, LiveKit, and recovery.

For SDK development, see [contributing](docs/development.md). `bun run check`
validates generated contracts, the public API, types, tests, and the build.
