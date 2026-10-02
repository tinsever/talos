import { RESTClient, GatewayClient, LRUCache } from "../dist/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const rest = new RESTClient({
  api: "https://public.example/api",
  token: "secret",
  fetch: async (url, init) => {
    assert(
      String(url) === "https://public.example/api/v1/users/@me",
      "Wrong API URL",
    );
    assert(
      new Headers(init.headers).get("Authorization") === "Bot secret",
      "Wrong credential",
    );
    return new Response(JSON.stringify({ id: "1", username: "bot" }), {
      headers: { "Content-Type": "application/json" },
    });
  },
});
assert(
  (await rest.request("GET", "/users/@me")).id === "1",
  "REST response failed",
);
const cache = new LRUCache(1);
cache.set("a", 1).set("b", 2);
assert(cache.size === 1 && cache.get("a") === undefined, "Cache failed");

class Socket extends EventTarget {
  readyState = 1;
  frames = [];
  send(frame) {
    this.frames.push(JSON.parse(frame));
  }
  close() {
    this.readyState = 3;
  }
  receive(data) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
}
const socket = new Socket();
const gateway = new GatewayClient({
  url: "wss://gateway.example",
  token: "raw",
  webSocket: () => socket,
});
const connected = gateway.connect();
socket.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
assert(
  socket.frames[0].op === 2 && socket.frames[0].d.token === "raw",
  "Identify failed",
);
socket.receive({
  op: 0,
  t: "READY",
  s: 1,
  d: { session_id: "s", user: { id: "1", username: "bot" } },
});
await connected;
gateway.disconnect();
console.log("REST, injected WebSocket gateway, and cache smoke passed.");
