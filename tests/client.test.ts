import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import { discover } from "../src/discovery.js";
import { Messages, multipart } from "../src/messages.js";
import { RESTClient } from "../src/rest.js";
import { LRUCache } from "../src/cache.js";
import { Resources } from "../src/resources.js";
import { TypedEmitter } from "../src/events.js";
import { FakeSocket, json, message, user } from "./helpers.js";
const clients: Client[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function clientSetup(cache = 0) {
  const socket = new FakeSocket();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(json(message()));
  const client = new Client({
    token: "secret",
    endpoints: {
      api_public: "https://public.example",
      gateway: "wss://gateway.example",
    },
    rest: { fetch },
    gateway: { webSocket: () => socket },
    cache: { messages: cache },
  });
  clients.push(client);
  return { client, socket, fetch };
}
describe("bot integration", () => {
  it("retains native snapshot fallback for caller-supplied built-ins and cycles", () => {
    const manager = new Messages(new RESTClient({ api: "https://example.test", token: "s" }));
    const author = { ...user, date: new Date(0), self: undefined as unknown };
    author.self = author;
    const wrapped = manager.wrap({ ...message(), author });
    expect(wrapped.author.username).toBe("bot");
    expect(Object.isFrozen(wrapped.author)).toBe(true);
    expect(wrapped.author).not.toBe(author);
    const result = wrapped.author as typeof author;
    expect(result.self).toBe(result);
    expect(result.date).toEqual(author.date);
    author.username = "changed";
    expect(wrapped.author.username).toBe("bot");
  });

  it.each(["resources", "messages", "emitter"] as const)(
    "keeps payloads isolated when the %s prototype is customized",
    async (hook) => {
      const { client, socket } = clientSetup();
      const connecting = client.connect();
      socket.hello(); socket.ready(); await connecting;
      let raw: ReturnType<typeof message> | undefined;
      if (hook === "resources") {
        const original = Resources.prototype.apply;
        vi.spyOn(Resources.prototype, "apply").mockImplementation(function (this: Resources, dispatch) {
          if (dispatch.t === "MESSAGE_CREATE") raw = dispatch.d;
          return original.call(this, dispatch);
        });
      } else if (hook === "messages") {
        const original = Messages.prototype.wrap;
        vi.spyOn(Messages.prototype, "wrap").mockImplementation(function (this: Messages, data) {
          raw = data;
          return original.call(this, data);
        });
      } else {
        const original = TypedEmitter.prototype.emit;
        vi.spyOn(TypedEmitter.prototype, "emit").mockImplementation(function (this: TypedEmitter<any>, event, value) {
          if (event === "dispatch" && value.t === "MESSAGE_CREATE") raw = value.d;
          return original.call(this, event, value);
        });
      }
      const received = client.waitFor("messageCreate", () => true, { timeoutMs: 1000 });
      socket.receive(0, message(), "MESSAGE_CREATE", 2);
      const wrapped = await received;
      raw!.author.username = "changed";
      raw!.content = "changed";
      expect(wrapped.author.username).toBe("bot");
      expect(wrapped.content).toBe("hello");
      expect(Object.isFrozen(raw)).toBe(false);
    },
  );

  it("materializes immutable nested JSON before it escapes through data or author", async () => {
    const { client, socket } = clientSetup(1);
    const connecting = client.connect();
    socket.hello(); socket.ready(); await connecting;
    const received = client.waitFor("messageCreate", () => true, { timeoutMs: 1000 });
    socket.receive(0, { ...message(), embeds: [{ title: "original", fields: [{ name: "field", value: "value" }] }],
      ...JSON.parse('{"extra":{"nested":[{"value":1}]},"__proto__":{"value":2}}'),
    }, "MESSAGE_CREATE", 2);
    const wrapped = await received;
    expect(wrapped.content).toBe("hello");
    expect(wrapped.id).toBe("20");
    expect(wrapped.channelId).toBe("10");
    expect(wrapped.guildId).toBeNull();
    const author = wrapped.author;
    expect(Object.isFrozen(author)).toBe(true);
    expect(() => { author.username = "changed"; }).toThrow(TypeError);
    const data = wrapped.data;
    expect(wrapped.data).toBe(data);
    expect(wrapped.author).toBe(author);
    expect(Object.keys(wrapped)).toContain("data");
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.embeds![0]!.fields![0])).toBe(true);
    const extra = data as unknown as { extra: { nested: { value: number }[] }; __proto__: object };
    expect(Object.isFrozen(extra.extra.nested[0])).toBe(true);
    expect(Object.hasOwn(data, "__proto__")).toBe(true);
    expect(Object.isFrozen(extra.__proto__)).toBe(true);
    expect(() => { data.embeds![0]!.title = "changed"; }).toThrow(TypeError);
    expect(client.cache.get("10:20")).toBe(wrapped);
  });

  it.each(["freeze", "seal", "preventExtensions"] as const)(
    "allows data access after Object.%s on an unmaterialized message",
    async (method) => {
      const { client, socket } = clientSetup(1);
      const connecting = client.connect();
      socket.hello(); socket.ready(); await connecting;
      socket.receive(0, message(), "MESSAGE_CREATE", 2);
      const wrapped = client.cache.get("10:20")!;
      (Object[method] as (value: object) => object)(wrapped);
      expect(wrapped.data.content).toBe("hello");
      expect(wrapped.data).toBe(wrapped.data);
      expect(Object.isFrozen(wrapped.data.mentions)).toBe(true);
      expect(() => { wrapped.data.content = "changed"; }).toThrow(TypeError);
    },
  );

  it("still emits when a raw dispatch observer subscribes to messageCreate during dispatch", async () => {
    const { client, socket } = clientSetup();
    const connecting = client.connect();
    socket.hello(); socket.ready(); await connecting;
    const listener = vi.fn();
    client.on("dispatch", dispatch => {
      if (dispatch.t === "MESSAGE_CREATE") client.once("messageCreate", listener);
    });
    socket.receive(0, message(), "MESSAGE_CREATE", 2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0].content).toBe("hello");
  });

  it("skips unused messages while preserving customized wrapper and emitter hooks", async () => {
    const { client, socket } = clientSetup();
    const connecting = client.connect();
    socket.hello(); socket.ready(); await connecting;
    const wrap = vi.spyOn(client.messages, "wrap");
    socket.receive(0, message(), "MESSAGE_CREATE", 2);
    expect(wrap).toHaveBeenCalledTimes(1);
    wrap.mockRestore();
    const emit = vi.spyOn(client, "emit");
    socket.receive(0, message(), "MESSAGE_CREATE", 3);
    expect(emit).toHaveBeenCalledWith("messageCreate", expect.objectContaining({ content: "hello" }));
    emit.mockRestore();
    const ignored = vi.spyOn(JSON, "parse");
    socket.receive(0, message(), "MESSAGE_CREATE", 4);
    const parsed = ignored.mock.results.at(-1)!.value;
    expect(Object.isFrozen(parsed.d)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(parsed.d, "content")?.value).toBe("hello");
    expect(client.cache.size).toBe(0);
    ignored.mockRestore();
  });

  it("isolates messages when a customized resource handler retains the payload", async () => {
    const { client, socket } = clientSetup();
    const connecting = client.connect();
    socket.hello(); socket.ready(); await connecting;
    const original = client.resources.apply.bind(client.resources);
    let raw: ReturnType<typeof message> | undefined;
    vi.spyOn(client.resources, "apply").mockImplementation(dispatch => {
      if (dispatch.t === "MESSAGE_CREATE") raw = dispatch.d;
      original(dispatch);
    });
    const received = client.waitFor("messageCreate", () => true, { timeoutMs: 1000 });
    socket.receive(0, message(), "MESSAGE_CREATE", 2);
    const wrapped = await received;
    expect(Object.isFrozen(raw)).toBe(false);
    raw!.content = "changed";
    expect(wrapped.content).toBe("hello");
  });
  it("copies transport data before invoking a customized message wrapper", async () => {
    const { client, socket } = clientSetup();
    const connecting = client.connect();
    socket.hello(); socket.ready(); await connecting;
    const original = client.messages.wrap.bind(client.messages);
    let raw: ReturnType<typeof message> | undefined;
    vi.spyOn(client.messages, "wrap").mockImplementation(data => {
      raw = data;
      return original(data);
    });
    const received = client.waitFor("messageCreate", () => true, { timeoutMs: 1000 });
    socket.receive(0, message(), "MESSAGE_CREATE", 2);
    const wrapped = await received;
    raw!.content = "changed";
    expect(wrapped.content).toBe("hello");
  });
  it.each(["client", "gateway", "processing hook"] as const)(
    "keeps raw payloads mutable and message snapshots isolated with a %s observer",
    async (observer) => {
      const socket = new FakeSocket();
      let raw: ReturnType<typeof message> | undefined;
      const client = new Client({ token: "x",
        endpoints: { api_public: "https://example", gateway: "wss://example" },
        gateway: { webSocket: () => socket,
          ...(observer === "processing hook" ? { processDispatch: async (dispatch: { t: string; d: unknown }) => {
            if (dispatch.t === "MESSAGE_CREATE") raw = dispatch.d as ReturnType<typeof message>;
          } } : {}),
        },
      });
      clients.push(client);
      if (observer === "client") client.on("dispatch", dispatch => {
        if (dispatch.t === "MESSAGE_CREATE") raw = dispatch.d as ReturnType<typeof message>;
      });
      const connecting = client.connect();
      socket.hello(); socket.ready(); await connecting;
      if (observer === "gateway") client.gateway.on("dispatch", dispatch => {
        if (dispatch.t === "MESSAGE_CREATE") raw = dispatch.d as ReturnType<typeof message>;
      });
      const received = client.waitFor("messageCreate", () => true, { timeoutMs: 1000 });
      socket.receive(0, message(), "MESSAGE_CREATE", 2);
      const wrapped = await received;
      expect(Object.isFrozen(wrapped.data.author)).toBe(true);
      expect(Object.isFrozen(raw)).toBe(false);
      raw!.content = "changed";
      raw!.author.username = "changed";
      expect(wrapped.content).toBe("hello");
      expect(wrapped.author.username).toBe("bot");
    },
  );

  it("keeps unobserved transport messages deeply immutable and caches the emitted snapshot", async () => {
    const { client, socket } = clientSetup(1);
    const connecting = client.connect();
    socket.hello(); socket.ready(); await connecting;
    const received = client.waitFor("messageCreate", () => true, { timeoutMs: 1000 });
    socket.receive(0, message(), "MESSAGE_CREATE", 2);
    const wrapped = await received;
    expect(client.cache.get("10:20")).toBe(wrapped);
    expect(() => { wrapped.author.username = "changed"; }).toThrow(TypeError);
    expect(() => { wrapped.data.mentions.push(user); }).toThrow(TypeError);
  });
  it("rejects invalid token rotation before changing REST authorization", async () => {
    const { client, socket, fetch } = clientSetup();
    const connecting = client.connect();
    socket.hello();
    socket.ready();
    await connecting;
    expect(() => client.updateToken("Bot malformed")).toThrow();
    await client.rest.request("GET", "/users/@me");
    expect(
      new Headers(fetch.mock.calls[0]![1]!.headers).get("Authorization"),
    ).toBe("Bot secret");
    client.updateToken("replacement");
    fetch.mockResolvedValueOnce(json(user));
    await client.rest.request("GET", "/users/@me");
    expect(
      new Headers(fetch.mock.calls[1]![1]!.headers).get("Authorization"),
    ).toBe("Bot replacement");
  });

  it("receives a message, replies, and suppresses accidental mentions", async () => {
    const { client, socket, fetch } = clientSetup();
    const done = client.waitFor(
      "messageCreate",
      (value) => value.content === "!ping",
      { timeoutMs: 1_000 },
    );
    const connected = client.connect();
    socket.hello();
    socket.ready();
    await connected;
    expect(client.user).toEqual(user);
    socket.receive(0, { ...message(), content: "!ping" }, "MESSAGE_CREATE", 2);
    const received = await done;
    await received.reply("Pong!");
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      content: "Pong!",
      message_reference: { message_id: "20", channel_id: "10" },
      allowed_mentions: { parse: [], replied_user: false },
    });
    expect(client.cache.size).toBe(0);
  });
  it("keeps bounded optional cache current across partial updates and deletes", async () => {
    const { client, socket } = clientSetup(1);
    const connected = client.connect();
    socket.hello();
    socket.ready();
    await connected;
    socket.receive(0, message("20"), "MESSAGE_CREATE", 2);
    socket.receive(0, message("21"), "MESSAGE_CREATE", 3);
    expect(client.cache.get("10:20")).toBeUndefined();
    expect(client.cache.size).toBe(1);
    socket.receive(
      0,
      { id: "21", channel_id: "10", content: "updated" },
      "MESSAGE_UPDATE",
      4,
    );
    expect(client.cache.get("10:21")?.content).toBe("updated");
    expect(client.cache.get("10:21")?.author).toEqual(user);
    socket.receive(
      0,
      { ids: ["21"], channel_id: "10" },
      "MESSAGE_DELETE_BULK",
      5,
    );
    expect(client.cache.size).toBe(0);
  });
  it("cancels discovery when disconnected and never opens a socket", async () => {
    const webSocket = vi.fn(() => new FakeSocket());
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => new Promise(() => {}));
    const client = new Client({
      token: "s",
      rest: { fetch },
      gateway: { webSocket },
    });
    clients.push(client);
    const connected = client.connect();
    const assertion = expect(connected).rejects.toMatchObject({
      name: "AbortError",
    });
    client.disconnect();
    await assertion;
    expect(webSocket).not.toHaveBeenCalled();
  });
  it("waitFor cleans up after a predicate exception, timeout, and cancellation", async () => {
    vi.useFakeTimers();
    const { client } = clientSetup();
    const controller = new AbortController();
    const waiting = client.waitFor("state", () => true, {
      timeoutMs: 100,
      signal: controller.signal,
    });
    const abortAssertion = expect(waiting).rejects.toThrow("cancel");
    controller.abort(new Error("cancel"));
    await abortAssertion;
    const timeout = client.waitFor("state", () => true, { timeoutMs: 10 });
    const timeoutAssertion = expect(timeout).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(10);
    await timeoutAssertion;
    const predicate = client.waitFor(
      "state",
      () => {
        throw new Error("predicate");
      },
      { timeoutMs: 10 },
    );
    const predicateAssertion = expect(predicate).rejects.toThrow("predicate");
    client.emit("state", "ready");
    await predicateAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe("discovery and message tools", () => {
  it("uses unversioned discovery and preserves advertised http endpoints and ports", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        endpoints: {
          api_public: "http://public.example:8080/api",
          api_client: "https://firstparty.example",
          gateway: "ws://example:8090/gateway",
        },
      }),
    );
    const instance = await discover("https://example/prefix", { fetch });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://example/.well-known/fluxer",
    );
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      redirect: "follow",
      credentials: "omit",
    });
    expect(instance.endpoints.api_public).toBe(
      "http://public.example:8080/api",
    );
  });
  it("requires api_public rather than falling back to first-party API", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        endpoints: { api: "https://example", gateway: "wss://example" },
      }),
    );
    await expect(discover("https://example", { fetch })).rejects.toThrow(
      "api_public",
    );
  });
  it("constructs inline attachments with unique IDs while retaining attachments", async () => {
    const form = multipart(
      { content: "upload", attachments: [{ id: 0, filename: "existing.txt" }] },
      [{ data: new Blob(["file"]), name: "new.txt", description: "alt" }],
    );
    const payload = JSON.parse(form.get("payload_json") as string);
    expect(payload.attachments).toEqual([
      { id: 0, filename: "existing.txt" },
      { id: 1, filename: "new.txt", description: "alt" },
    ]);
    expect(await (form.get("files[1]") as Blob).text()).toBe("file");
  });
  it("paginates lazily and stops at the requested limit", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json(Array.from({ length: 100 }, (_, i) => message(String(200 - i)))),
      )
      .mockResolvedValueOnce(json([message("100"), message("99")]));
    const messages = new Messages(
      new RESTClient({ api: "https://example", token: "s", fetch }),
    );
    const history = messages.history("10", { limit: 102 });
    expect(fetch).not.toHaveBeenCalled();
    const seen: string[] = [];
    for await (const item of history) seen.push(item.id);
    expect(seen).toHaveLength(102);
    expect(String(fetch.mock.calls[1]![0])).toContain("limit=2&before=101");
  });
  it("lets early iterator return prevent more page requests", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        json(Array.from({ length: 100 }, (_, i) => message(String(i)))),
      );
    const messages = new Messages(
      new RESTClient({ api: "https://example", token: "s", fetch }),
    );
    for await (const item of messages.history("10")) {
      expect(item.id).toBe("0");
      break;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("expires and evicts cache entries without background timers", () => {
    vi.useFakeTimers();
    const cache = new LRUCache<string, number>(2, 100);
    cache.set("a", 1).set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    vi.advanceTimersByTime(100);
    expect(cache.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
