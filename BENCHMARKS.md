# Talos latency benchmark — 2026-10-02

Ordinary SDK processing is already measured in microseconds. The largest avoidable costs are bulk resource hydration with disabled caches, listener promise allocation under fan-out, and full cache scans. These measurements identify candidates; SDK runtime source was left unchanged.

Ran Node v20.19.2 and Bun 1.4.2 sequentially on the same Linux x64 environment (AMD EPYC, 6 logical CPUs). Each runtime ran 49 cases over five rounds, with warmup and rotated case order. Ordinary cases have 5,000 samples; larger events and bursts have fewer samples, recorded in the raw data. Both runs used the same SDK source hash: `7cc5d5be69c06d6f616519e946c3322994def533372e4f4dcf2a9b68e00dfed6`.

[Node raw results](benchmarks/node.json) · [Bun raw results](benchmarks/bun.json) · [Benchmark runner](scripts/benchmark.mjs)

All times below are milliseconds. p50 is the median; p95 covers 95% of measured operations. Small message frames are 360 bytes and rich frames are 7,710 bytes. Gateway/client cases inject preencoded text through a synthetic socket, including parsing and delivery but excluding network transport. REST loopback cases use real HTTP with warm connections and no TLS or external API.

| Operation | Node p50 | Node p95 | Bun p50 | Bun p95 |
|---|---:|---:|---:|---:|
| Raw gateway, small message | 0.0024 | 0.0045 | 0.0012 | 0.0027 |
| Client messageCreate, small message | 0.0141 | 0.0220 | 0.0075 | 0.0148 |
| Client messageCreate, rich message | 0.0542 | 0.1117 | 0.0444 | 0.0825 |
| Injected fetch + JSON (no SDK) | 0.0465 | 0.0798 | 0.0018 | 0.0038 |
| REST GET + injected fetch + JSON | 0.0917 | 0.1556 | 0.0098 | 0.0223 |
| Loopback HTTP: direct fetch + JSON | 0.4668 | 0.6729 | 0.1102 | 0.2081 |
| Loopback HTTP: REST GET + JSON | 0.5230 | 0.7881 | 0.1501 | 0.3121 |
| Guild: 500 channels + 500 roles, caches off | 3.2529 | 5.3184 | 1.1303 | 1.7209 |
| Hydrate 1,000 members, caches off | 8.4840 | 12.8961 | 5.7171 | 7.4632 |
| Read cache.size, 10,000 live entries | 0.5349 | 0.8446 | 0.4487 | 0.6709 |

1. **Skip resource hydration for disabled caches first.** [Resources.apply](src/resources.ts) constructs and snapshots channels, roles, members, and users even when every relevant cache has capacity zero. A temporary guard for the all-disabled case reduced complete guild-event processing from **3.253 → 0.437 ms on Node (87% less)** and **1.130 → 0.268 ms on Bun (76% less)**. The remaining cost is mostly JSON parsing. Direct 1,000-member hydration cost 8.484 ms on Node and 5.717 ms on Bun; the guard returned at the measurement floor. For production, handle partially enabled caches too, retain READY/reset behavior, and preserve immutable snapshots for data that is actually exposed or stored.

2. **Avoid promises for synchronous listener returns.** [TypedEmitter.emit](src/events.ts) currently calls `Promise.resolve(result).catch(...)` for every listener, including callbacks returning `undefined`. The temporary fast path retained listener snapshots and synchronous error handling, and only assimilated object/function results. At 100 listeners, median emission fell **0.00678 → 0.00124 ms on Node** and **0.00763 → 0.00105 ms on Bun**, reductions of 82–86%. A 1,000-event burst with 10 listeners fell 0.506 → 0.119 ms on Node and 0.571 → 0.117 ms on Bun. Checked sync errors, rejected promises, custom thenables, subscription mutation, and reentrant once listeners. Ordinary rich-message delivery showed no consistent improvement, so prioritize this for heavy event fan-out.

3. **Reduce cache sweep cost.** [LRUCache.size](src/cache.ts) calls `sweep()`, which reads `Date.now()` once per entry. Hoisting the clock read outside the loop reduced a 10,000-entry scan from **0.535 → 0.068 ms on Node (87% less)** and **0.449 → 0.074 ms on Bun (84% less)**. This remains O(n). Skip sweeping for infinite TTLs, and consider tracking the next expiration to skip scans until needed. Keep expiration and recency guarantees. Normal rotating cache hits were already about 0.0003–0.0005 ms at 10,000 entries; scanning size is the issue.

4. **Make message wrapping lazy where it is unused.** [Client dispatch handling](src/client.ts) wraps every MESSAGE_CREATE even with message caching disabled and no messageCreate subscribers. `Client.onDispatch` still takes that path. The supported `GatewayClient` raw dispatch path measured 0.0012 ms on Bun versus 0.0075 ms for an ordinary wrapped message, and 0.0088 versus 0.0444 ms for a rich message. A lazy wrapper could approach the raw path when the high-level object is unused; this candidate was identified from the code and was not patched in the experiment. Preserve cloning/freezing whenever a wrapped Message is delivered or cached, since public dispatch listeners can retain or modify payloads.

5. **Investigate REST scheduling before shaving tiny allocations.** [RESTClient.lock](src/rest.ts) serializes each concrete method/path until the response body is consumed. With a synthetic 2 ms fetch delay, a 50-request burst to one path took **122 ms on Node / 109 ms on Bun**; 50 distinct paths at concurrency 10 took **16 ms / 11 ms**. This is intentional queueing, not network latency or a benchmark-proven defect. Consider opt-in coalescing of identical safe reads or quota-aware concurrency only after verifying rate limits, cancellation, authentication/query equivalence, and response ownership. Also investigate rate-limit waits holding semaphore slots. These REST redesigns were not experimentally implemented.

For a meaningful near-zero target, track local processing p95/p99 and allocations separately from transport, queue waits, and rate limits. [Gateway heartbeat](src/gateway.ts) and REST diagnostics use whole-millisecond `Date.now()` differences; a reported 0 ms can simply mean sub-millisecond timing. REST response diagnostics also omit the route-lock wait and body parsing. The benchmark uses `performance.now()` instead. An SDK cannot remove the network round trip.

Reproduce from the repository root (dev dependencies must be installed; the runner compiles its own temporary core bundle):

```sh
node scripts/benchmark.mjs --experiments --output .reports/benchmark-node.json
bun scripts/benchmark.mjs --experiments --output .reports/benchmark-bun.json
```

`npm run bench -- ...` and `bun run bench:bun ...` are equivalent helpers. Omit `--experiments` for the baseline only. Use `--filter cache` to select cases, or `TALOS_BENCH_ROUNDS=10 TALOS_BENCH_SCALE=2` for more samples. Repeated-key cache hits are rotated across the full cache. Experiments modify prototypes temporarily within the benchmark process and restore them afterward. Patched client cases include the extra patch/restore overhead.

Each latency sample includes the operation, an await, and immediate promise reactions. The empty-harness median was 0.00024 ms on Node and 0.00016 ms on Bun; no baseline subtraction was applied. Results include GC and scheduler outliers. Sub-microsecond differences and comparisons between separately warmed paths are noisy; inspect round mean ranges and rerun on deployment hardware before treating small changes as wins. These are local measurements, not production HTTP/WebSocket or heartbeat latency.

Validation: both complete benchmark runs finished with zero gateway errors, zero pending REST requests, and observed delayed-fetch concurrency of 10. Type checking passed. Tests passed: 231 passed, 1 skipped. Generated API/gateway contracts passed. The full `bun run check` stopped at a public-API snapshot mismatch in the current workspace; benchmark changes do not alter the SDK public API. Voice files were being edited during the audit, but they are excluded from the measured core bundle.
