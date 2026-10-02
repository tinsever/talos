import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { build } from "esbuild";

// Compile only the measured SDK modules. No dist dependency or live credentials.
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "talos-benchmark-"));
const modules = ["client", "gateway", "rest", "events", "cache", "snapshot", "resources"];
const compiled = await build({
  stdin: {
    contents: modules.map((name) => `export * from './src/${name}.ts';`).join("\n"),
    resolveDir: root,
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  absWorkingDir: root,
  outfile: join(temporary, "sdk.mjs"),
  metafile: true,
});
const sdk = await import(pathToFileURL(join(temporary, "sdk.mjs")).href);
const { Client, GatewayClient, RESTClient, TypedEmitter, LRUCache, snapshot, Resources } = sdk;
const nodeCompiled = await build({
  entryPoints: [join(root, "src/node-http.ts")], bundle: true, format: "esm",
  platform: "node", target: "es2022", absWorkingDir: root,
  outfile: join(temporary, "node-http.mjs"), metafile: true,
});
const { nodeHTTPTransport } = await import(pathToFileURL(join(temporary, "node-http.mjs")).href);
const sourceHash = createHash("sha256");
for (const input of Object.keys({ ...compiled.metafile.inputs, ...nodeCompiled.metafile.inputs }).sort()) {
  if (input === "<stdin>") continue;
  sourceHash.update(input).update(await readFile(join(root, input)));
}
const { values } = parseArgs({ options: {
  experiments: { type: "boolean", default: false },
  output: { type: "string" },
  filter: { type: "string" },
} });
const rounds = Number(process.env.TALOS_BENCH_ROUNDS ?? 5);
const sampleScale = Number(process.env.TALOS_BENCH_SCALE ?? 1);
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100, "TALOS_BENCH_ROUNDS must be 1..100");
assert(Number.isFinite(sampleScale) && sampleScale > 0 && sampleScale <= 100, "TALOS_BENCH_SCALE must be >0 and <=100");
const experiments = values.experiments;
let consumed = 0;
const user = { id: "1", username: "bot", discriminator: "0001", bot: true, global_name: null, avatar: null, avatar_color: null, flags: 0 };
const message = {
  id: "20", channel_id: "10", author: user, content: "!ping", timestamp: "2026-10-02T00:00:00Z",
  type: 0, flags: 0, pinned: false, mention_everyone: false, tts: false, mentions: [], mention_roles: [],
};
const richMessage = {
  ...message, content: "x".repeat(2000),
  embeds: Array.from({ length: 4 }, (_, i) => ({ title: `Embed ${i}`, description: "text".repeat(100), fields: Array.from({ length: 6 }, (_, j) => ({ name: `Field ${j}`, value: "value".repeat(20) })) })),
  attachments: Array.from({ length: 4 }, (_, i) => ({ id: String(i), filename: `file${i}.png`, size: 1024, url: `https://example.test/${i}`, content_type: "image/png" })),
};
const frame = (data, t = "MESSAGE_CREATE") => JSON.stringify({ op: 0, t, s: 2, d: data });
const messageFrame = frame(message), richFrame = frame(richMessage);
const cases = [];
const cleanup = [];
const errors = [];
function add(name, operation, samples = 1000, unit = "operation") {
  cases.push({ name, operation, samples: Math.max(10, Math.round(samples * sampleScale)), unit, timings: [], roundMeans: [] });
}
class SyntheticSocket {
  readyState = 1;
  listeners = new Map();
  send() {}
  close() { this.readyState = 3; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  receive(data) { for (const listener of this.listeners.get("message") ?? []) listener({ data }); }
  ready() {
    this.receive(JSON.stringify({ op: 10, d: { heartbeat_interval: 2147483647 } }));
    this.receive(frame({ session_id: "benchmark", user }, "READY"));
  }
}
async function connected(highLevel = false, options = {}) {
  const socket = new SyntheticSocket();
  const client = highLevel
    ? new Client({ token: "synthetic", endpoints: { api_public: "https://example.test", gateway: "ws://example.test" }, gateway: { webSocket: () => socket, ...options.gateway }, cache: options.cache })
    : new GatewayClient({ token: "synthetic", url: "ws://example.test", webSocket: () => socket, ...options.gateway });
  client.on("error", (error) => { errors.push(error); });
  const connecting = client.connect();
  socket.ready();
  await connecting;
  cleanup.push(() => client.disconnect());
  return { client, socket };
}

// Experimental changes live only in this process; production source is untouched.
const originalEmit = TypedEmitter.prototype.emit;
function fastEmit(event, value) {
  const listeners = this.listeners.get(event);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      const result = listener(value);
      if (result !== null && (typeof result === "object" || typeof result === "function"))
        Promise.resolve(result).catch((error) => this.onListenerError(error, event));
    } catch (error) { this.onListenerError(error, event); }
  }
}
const originalApply = Resources.prototype.apply;
function skipDisabledCaches(event) {
  if (this.users.cache.maxSize === 0 && this.channels.cache.maxSize === 0 && this.guilds.cache.maxSize === 0 && this.memberCache.maxSize === 0 && this.roleCache.maxSize === 0) return;
  return originalApply.call(this, event);
}
async function withPatch(prototype, key, implementation, operation) {
  const previous = prototype[key];
  prototype[key] = implementation;
  try { return await operation(); } finally { prototype[key] = previous; }
}
async function validateFastEmitter() {
  const errors = [], calls = [];
  const emitter = new TypedEmitter((error) => errors.push(error));
  let off;
  emitter.on("event", () => { off(); calls.push("first"); });
  off = emitter.on("event", () => { calls.push("second"); });
  emitter.on("event", () => { throw "sync"; });
  emitter.on("event", () => Promise.reject("async"));
  emitter.on("event", () => ({ then(_resolve, reject) { reject("thenable"); } }));
  await withPatch(TypedEmitter.prototype, "emit", fastEmit, async () => {
    emitter.emit("event", 1);
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(errors, ["sync", "async", "thenable"]);
  let once = 0;
  const reentrant = new TypedEmitter();
  reentrant.once("event", () => { once++; reentrant.emit("event", 0); });
  await withPatch(TypedEmitter.prototype, "emit", fastEmit, () => reentrant.emit("event", 0));
  assert.equal(once, 1);
}

let server;
try {
  if (experiments) await validateFastEmitter();
  add("harness/empty await", () => { consumed++; });
  add("json/parse small message", () => { consumed += JSON.parse(messageFrame).s; });
  add("json/parse rich message", () => { consumed += JSON.parse(richFrame).s; });
  add("snapshot/small message", () => { consumed += snapshot(message).id.length; });
  add("snapshot/rich message", () => { consumed += snapshot(richMessage).id.length; }, 500);
  add("clone/small message without freeze", () => { consumed += structuredClone(message).id.length; });
  add("clone/rich message without freeze", () => { consumed += structuredClone(richMessage).id.length; }, 500);
  for (const count of [0, 1, 10, 100]) {
    const emitter = new TypedEmitter();
    for (let i = 0; i < count; i++) emitter.on("value", (value) => { consumed += value; });
    add(`emit/${count} sync listeners`, () => emitter.emit("value", 1));
    if (experiments) {
      add(`experiment/emit ${count} sync listeners`, () => fastEmit.call(emitter, "value", 1));
    }
  }
  const burstEmitter = new TypedEmitter();
  for (let i = 0; i < 10; i++) burstEmitter.on("value", (value) => { consumed += value; });
  add("emit/burst 1000 x 10 listeners", () => { for (let i = 0; i < 1000; i++) burstEmitter.emit("value", 1); }, 50, "1000-event burst");
  if (experiments) add("experiment/emit burst 1000 x 10", () => { for (let i = 0; i < 1000; i++) fastEmit.call(burstEmitter, "value", 1); }, 50, "1000-event burst");

  for (const size of [100, 1000, 10000]) {
    const cache = new LRUCache(size, 300000);
    for (let i = 0; i < size; i++) cache.set(i, i);
    let key = 0;
    add(`cache/hit ${size} entries`, () => { consumed += cache.get(key++ % size); });
    add(`cache/size ${size} entries`, () => { consumed += cache.size; }, 300);
    if (experiments) add(`experiment/cache sweep ${size} entries one clock read`, () => {
      const now = Date.now();
      for (const [key, entry] of cache.entries)
        if (entry.expires <= now) cache.entries.delete(key);
      consumed += cache.entries.size;
    }, 300);
  }
  const gateway = await connected();
  gateway.client.on("dispatch", (dispatch) => { consumed += dispatch.s; });
  add("gateway/raw small message", () => gateway.socket.receive(messageFrame));
  add("gateway/raw rich message", () => gateway.socket.receive(richFrame), 500);
  const durable = await connected(false, { gateway: { processDispatch: async () => {} } });
  let durableResolve;
  durable.client.on("dispatch", () => durableResolve?.());
  add("gateway/ordered no-op hook", () => new Promise((resolve) => { durableResolve = resolve; durable.socket.receive(messageFrame); }));
  const high = await connected(true);
  high.client.on("messageCreate", (value) => { consumed += value.id.length; });
  add("client/small message cache off", () => high.socket.receive(messageFrame));
  add("client/rich message cache off", () => high.socket.receive(richFrame), 500);
  add("client/small message burst 1000 cache off", () => {
    for (let i = 0; i < 1000; i++) high.socket.receive(messageFrame);
  }, 10, "1000-message burst");
  add("client/rich message burst 1000 cache off", () => {
    for (let i = 0; i < 1000; i++) high.socket.receive(richFrame);
  }, 10, "1000-message burst");
  const withAuthor = await connected(true);
  withAuthor.client.on("messageCreate", (value) => { consumed += value.author.username.length + value.content.length; });
  add("client/rich message burst 1000 read author", () => {
    for (let i = 0; i < 1000; i++) withAuthor.socket.receive(richFrame);
  }, 10, "1000-message burst");
  const withData = await connected(true);
  withData.client.on("messageCreate", (value) => {
    const data = value.data;
    assert(Object.isFrozen(data) && Object.isFrozen(data.embeds[0].fields[0]));
    for (const embed of data.embeds) for (const field of embed.fields) consumed += field.value.length;
  });
  add("client/rich message burst 1000 read full data", () => {
    for (let i = 0; i < 1000; i++) withData.socket.receive(richFrame);
  }, 10, "1000-message burst");
  const ignoredMessages = await connected(true);
  add("client/rich message burst 1000 no consumer", () => {
    for (let i = 0; i < 1000; i++) ignoredMessages.socket.receive(richFrame);
  }, 10, "1000-message burst");
  if (experiments) {
    add("experiment/client small fast emitter", () => withPatch(TypedEmitter.prototype, "emit", fastEmit, () => high.socket.receive(messageFrame)));
    add("experiment/client rich fast emitter", () => withPatch(TypedEmitter.prototype, "emit", fastEmit, () => high.socket.receive(richFrame)), 500);
  }
  const cached = await connected(true, { cache: { messages: 1000 } });
  cached.client.on("messageCreate", (value) => { consumed += value.id.length; });
  add("client/small message cache on", () => cached.socket.receive(messageFrame));
  add("client/rich message cache on", () => cached.socket.receive(richFrame), 500);
  const restOptions = { api: "https://example.test", token: "synthetic" };
  const resourceREST = new RESTClient(restOptions);
  const disabled = new Resources(() => resourceREST);
  const guild = { op: 0, t: "GUILD_CREATE", s: 3, d: {
    id: "10", properties: { id: "10", name: "Synthetic guild", owner_id: "1" },
    channels: Array.from({ length: 500 }, (_, i) => ({ id: String(i), type: 0, guild_id: "10", name: `Channel ${i}` })),
    roles: Array.from({ length: 500 }, (_, i) => ({ id: String(i), name: `Role ${i}`, position: i, permissions: "1024" })),
  } };
  const members = { op: 0, t: "GUILD_MEMBERS_CHUNK", s: 4, d: { guild_id: "10", members: Array.from({ length: 1000 }, (_, i) => ({ user: { ...user, id: String(i) }, roles: ["1"], nick: `Member ${i}` })) } };
  add("resources/guild 500 channels + 500 roles cache off", () => disabled.apply(guild), 50, "1000-resource event");
  add("resources/chunk 1000 members cache off", () => disabled.apply(members), 30, "1000-member event");
  const guildFrame = JSON.stringify(guild);
  add("client/guild cache off", () => high.socket.receive(guildFrame), 50, "1000-resource event");
  if (experiments) {
    add("experiment/resources guild skip disabled caches", () => skipDisabledCaches.call(disabled, guild), 50, "1000-resource event");
    add("experiment/resources members skip disabled caches", () => skipDisabledCaches.call(disabled, members), 30, "1000-member event");
    add("experiment/client guild skip disabled caches", () => withPatch(Resources.prototype, "apply", skipDisabledCaches, () => high.socket.receive(guildFrame)), 50, "1000-resource event");
  }
  const responseBody = JSON.stringify(message), responseHeaders = { "Content-Type": "application/json" };
  const syntheticFetch = async () => new Response(responseBody, { headers: responseHeaders });
  const mockREST = new RESTClient({ ...restOptions, fetch: syntheticFetch });
  add("fetch/injected response + json", async () => { consumed += (await (await syntheticFetch()).json()).id.length; });
  add("rest/injected GET + json", async () => { consumed += (await mockREST.request("GET", "/users/@me")).id.length; });
  add("rest/injected POST + json", async () => { consumed += (await mockREST.request("POST", "/channels/{channel_id}/messages", { params: { channel_id: "10" }, body: { content: "Pong" } })).id.length; });
  add("rest/injected same-route burst 50", () => Promise.all(Array.from({ length: 50 }, () => mockREST.request("GET", "/users/@me"))), 30, "50-request burst");

  let coalescedFetchCalls = 0, coalescedLogicalCalls = 0;
  const coalescedREST = new RESTClient({ ...restOptions, coalesceGets: true, fetch: async () => {
    coalescedFetchCalls++;
    return syntheticFetch();
  } });
  add("rest/coalesced same-route burst 50", async () => {
    coalescedLogicalCalls += 50;
    const responses = await Promise.all(Array.from({ length: 50 }, () => coalescedREST.request("GET", "/users/@me")));
    assert.equal(new Set(responses).size, 50);
    for (const value of responses) consumed += value.id.length;
  }, 30, "50-request burst");

  // Loopback measures real HTTP without external services, TLS, or rate limits.
  server = createServer((_req, res) => { res.writeHead(200, responseHeaders); res.end(responseBody); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const api = `http://127.0.0.1:${server.address().port}`;
  const httpREST = new RESTClient({ api, token: "synthetic" });
  const nodeTransport = nodeHTTPTransport();
  cleanup.push(() => nodeTransport.close());
  const nodeREST = new RESTClient({ api, token: "synthetic", fetch: nodeTransport.fetch });
  const headers = { Authorization: "Bot synthetic", "Accept-Language": "en-US" };
  add("http/direct fetch + json", async () => { consumed += (await (await fetch(`${api}/v1/users/@me`, { headers, credentials: "omit", redirect: "error" })).json()).id.length; }, 300);
  add("http/REST GET + json", async () => { consumed += (await httpREST.request("GET", "/users/@me")).id.length; }, 300);
  add("http/REST POST + json", async () => { consumed += (await httpREST.request("POST", "/channels/{channel_id}/messages", { params: { channel_id: "10" }, body: { content: "Pong" } })).id.length; }, 300);
  add("http/node pools GET + json", async () => { consumed += (await nodeREST.request("GET", "/users/@me")).id.length; }, 300);
  add("http/node pools POST + json", async () => { consumed += (await nodeREST.request("POST", "/channels/{channel_id}/messages", { params: { channel_id: "10" }, body: { content: "Pong" } })).id.length; }, 300);
  for (const method of ["GET", "POST"]) {
    for (const sameRoute of [true, false]) {
      add(`http/REST ${method} burst 50 ${sameRoute ? "same" : "different"} routes`, () => Promise.all(
        Array.from({ length: 50 }, (_, i) => method === "GET"
          ? httpREST.request("GET", "/users/{user_id}", { params: { user_id: sameRoute ? "1" : String(i) } })
          : httpREST.request("POST", "/channels/{channel_id}/messages", { params: { channel_id: sameRoute ? "10" : String(i) }, body: { content: "Pong" } })),
      ), 10, "50-request burst");
      add(`http/node pools ${method} burst 50 ${sameRoute ? "same" : "different"} routes`, () => Promise.all(
        Array.from({ length: 50 }, (_, i) => method === "GET"
          ? nodeREST.request("GET", "/users/{user_id}", { params: { user_id: sameRoute ? "1" : String(i) } })
          : nodeREST.request("POST", "/channels/{channel_id}/messages", { params: { channel_id: sameRoute ? "10" : String(i) }, body: { content: "Pong" } })),
      ), 10, "50-request burst");
    }
  }
  let inFlight = 0, peak = 0, calls = 0;
  const delayedREST = new RESTClient({ ...restOptions, maxConcurrentRequests: 10, fetch: async () => {
    inFlight++; peak = Math.max(peak, inFlight); calls++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight--;
    return new Response(responseBody, { headers: responseHeaders });
  } });
  add("queue/50 same routes + 2ms fetch", () => Promise.all(Array.from({ length: 50 }, () => delayedREST.request("GET", "/users/{user_id}", { params: { user_id: "1" } }))), 10, "50-request burst");
  add("queue/50 different routes + 2ms fetch", () => Promise.all(Array.from({ length: 50 }, (_, i) => delayedREST.request("GET", "/users/{user_id}", { params: { user_id: String(i) } }))), 10, "50-request burst");
  let sharedDelayedFetchCalls = 0, sharedDelayedLogicalCalls = 0;
  const sharedDelayedREST = new RESTClient({ ...restOptions, coalesceGets: true, fetch: async () => {
    sharedDelayedFetchCalls++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    return new Response(responseBody, { headers: responseHeaders });
  } });
  add("queue/50 coalesced same routes + 2ms fetch", () => {
    sharedDelayedLogicalCalls += 50;
    return Promise.all(Array.from({ length: 50 }, () => sharedDelayedREST.request("GET", "/users/{user_id}", { params: { user_id: "1" } })));
  }, 10, "50-request burst");

  if (values.filter) {
    for (let i = cases.length - 1; i >= 0; i--) if (!cases[i].name.includes(values.filter)) cases.splice(i, 1);
    assert(cases.length > 0, `No benchmark cases matched ${values.filter}`);
  }
  // Warm each path, then rotate order between rounds to reduce order bias.
  for (const entry of cases) {
    for (let i = 0; i < Math.min(entry.samples, 200); i++) await entry.operation();
  }
  for (let round = 0; round < rounds; round++) {
    const offset = Math.floor(cases.length * round / rounds);
    for (const entry of [...cases.slice(offset), ...cases.slice(0, offset)]) {
      const start = performance.now();
      for (let i = 0; i < entry.samples; i++) {
        const before = performance.now();
        await entry.operation();
        entry.timings.push(performance.now() - before);
      }
      entry.roundMeans.push((performance.now() - start) / entry.samples);
    }
    console.error(`Benchmark round ${round + 1}/${rounds} complete`);
  }
  assert.equal(mockREST.stats.pending, 0);
  assert.equal(httpREST.stats.pending, 0);
  assert.equal(nodeREST.stats.pending, 0);
  assert.equal(delayedREST.stats.pending, 0);
  assert.equal(coalescedREST.stats.pending, 0);
  assert.equal(sharedDelayedREST.stats.pending, 0);
  assert.equal(coalescedLogicalCalls, coalescedFetchCalls * 50);
  assert.equal(sharedDelayedLogicalCalls, sharedDelayedFetchCalls * 50);
  assert.equal(inFlight, 0);
  assert.deepEqual(errors, []);
  const percentile = (values, p) => values[Math.min(values.length - 1, Math.floor(values.length * p))];
  const result = {
    measuredAt: new Date().toISOString(),
    runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
    environment: { cpu: cpus()[0]?.model, logicalCPUs: cpus().length, platform: platform(), arch: arch() },
    sourceSHA256: sourceHash.digest("hex"),
    rounds, sampleScale, experiments, filter: values.filter ?? null,
    fixtures: { smallMessageFrameBytes: Buffer.byteLength(messageFrame), richMessageFrameBytes: Buffer.byteLength(richFrame), guildResources: 1000, chunkMembers: 1000 },
    methodology: "Warm serial operations timed with performance.now(), including await and immediate promise reactions. Percentiles are individual operation durations; mean includes timing/harness overhead. Burst rows time entire bursts. Synthetic socket excludes transport. Loopback HTTP uses warm connections, no TLS/external API. Experiments use temporary in-process prototype replacements, never edit SDK source; patched client cases include patch overhead. No baseline subtraction.",
    checks: { pending: 0, gatewayErrors: errors.length, delayedFetchCalls: calls, maxDelayedFetchConcurrency: peak, coalescedFetchCalls, coalescedLogicalCalls, sharedDelayedFetchCalls, sharedDelayedLogicalCalls, consumed },
    results: cases.map((entry) => {
      entry.timings.sort((a, b) => a - b);
      const means = [...entry.roundMeans].sort((a, b) => a - b);
      const meanMs = entry.roundMeans.reduce((a, b) => a + b, 0) / rounds;
      return { name: entry.name, unit: entry.unit, samples: entry.timings.length, p50Ms: percentile(entry.timings, 0.5), p95Ms: percentile(entry.timings, 0.95), p99Ms: percentile(entry.timings, 0.99), meanMs, operationsPerSecond: 1000 / meanMs, roundMeanMinMs: means[0], roundMeanMaxMs: means.at(-1) };
    }),
  };
  console.table(result.results.map(({ name, p50Ms, p95Ms, p99Ms }) => ({ name, p50_ms: p50Ms.toFixed(6), p95_ms: p95Ms.toFixed(6), p99_ms: p99Ms.toFixed(6) })));
  if (values.output) {
    const path = values.output;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(result, null, 2) + "\n");
    console.log(`Wrote ${path}`);
  } else console.log(JSON.stringify(result, null, 2));
} finally {
  TypedEmitter.prototype.emit = originalEmit;
  Resources.prototype.apply = originalApply;
  for (const dispose of cleanup) dispose();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(temporary, { recursive: true, force: true });
}
