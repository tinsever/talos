import { afterEach, describe, expect, it, vi } from "vitest";
import { RESTClient, RequestQueueFullError } from "../src/rest.js";
import { json, message } from "./helpers.js";

const api = "https://public.example/api";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("opt-in GET sharing", () => {
  it("shares one transport for 50 callers, returns independent data, and never caches completed reads", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      json({ id: "1", nested: { value: 1 } }));
    const rest = new RESTClient({ api, token: "s", fetch, coalesceGets: true });
    const values = await Promise.all(Array.from({ length: 50 }, () =>
      rest.request("GET", "/users/@me")));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Set(values).size).toBe(50);
    const first = values[0] as unknown as { nested: { value: number } };
    first.nested.value = 2;
    expect(values[1]).toEqual({ id: "1", nested: { value: 1 } });
    await rest.request("GET", "/users/@me");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rest.stats).toEqual({ pending: 0, active: 0, waiting: 0 });
  });

  it("leaves sharing disabled by default and supports per-request opt-in and opt-out", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json({}));
    const rest = new RESTClient({ api, token: "s", fetch });
    await Promise.all([rest.request("GET", "/users/@me"), rest.request("GET", "/users/@me")]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await Promise.all([rest.request("GET", "/users/@me", { coalesce: true }), rest.request("GET", "/users/@me", { coalesce: true })]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const enabled = new RESTClient({ api, token: "s", fetch, coalesceGets: true });
    await Promise.all([enabled.request("GET", "/users/@me"), enabled.request("GET", "/users/@me", { coalesce: false })]);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each([0, 1])("keeps deadlines independent when caller %i times out first", async (short) => {
    vi.useFakeTimers();
    let transportSignal!: AbortSignal;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      transportSignal = init!.signal!;
      await new Promise(resolve => setTimeout(resolve, 20));
      return json({ id: "1" });
    });
    const rest = new RESTClient({ api, token: "s", fetch, coalesceGets: true });
    const requests = [0, 1].map(i => rest.request("GET", "/users/@me", { timeoutMs: i === short ? 10 : 100 }));
    const timedOut = expect(requests[short]).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    expect(transportSignal.aborted).toBe(false);
    expect(rest.stats.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(await requests[1 - short]).toEqual({ id: "1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rest.stats).toEqual({ pending: 0, active: 0, waiting: 0 });
  });

  it("aborts transport only after the last caller leaves, even if fetch ignores signals", async () => {
    let transportSignal!: AbortSignal;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce((_url, init) => {
        transportSignal = init!.signal!;
        return new Promise(() => {});
      })
      .mockImplementation(async () => json({ id: "fresh" }));
    const rest = new RESTClient({ api, token: "s", fetch, coalesceGets: true, maxConcurrentRequests: 1 });
    const a = new AbortController(), b = new AbortController();
    const first = rest.request("GET", "/users/@me", { signal: a.signal });
    const second = rest.request("GET", "/users/@me", { signal: b.signal });
    const firstCancelled = expect(first).rejects.toBe("first");
    const secondCancelled = expect(second).rejects.toBe("last");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    a.abort("first");
    await firstCancelled;
    expect(transportSignal.aborted).toBe(false);
    b.abort("last");
    await secondCancelled;
    expect(transportSignal.aborted).toBe(true);
    expect(transportSignal.reason).toBe("last");
    expect(await rest.request("GET", "/users/@me")).toEqual({ id: "fresh" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rest.stats).toEqual({ pending: 0, active: 0, waiting: 0 });
  });

  it("does not fetch when all callers cancel before work starts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const rest = new RESTClient({ api, token: "s", fetch, coalesceGets: true });
    const a = new AbortController();
    const first = rest.request("GET", "/users/@me", { signal: a.signal });
    const second = rest.request("GET", "/users/@me", { signal: a.signal });
    const cancelled = Promise.all([expect(first).rejects.toBe("stop"), expect(second).rejects.toBe("stop")]);
    a.abort("stop");
    await cancelled;
    expect(fetch).not.toHaveBeenCalled();
    expect(rest.stats.pending).toBe(0);
    a.abort();
    await expect(rest.request("GET", "/users/@me", { signal: a.signal })).rejects.toBe("stop");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains queued work for a longer-lived caller after its first caller times out", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return json({});
    });
    const rest = new RESTClient({ api, token: "s", fetch, coalesceGets: true, maxConcurrentRequests: 1 });
    const occupied = rest.request("GET", "/users/{user_id}", { params: { user_id: "other" } });
    const first = rest.request("GET", "/users/@me", { timeoutMs: 10 });
    const timedOut = expect(first).rejects.toMatchObject({ name: "TimeoutError" });
    const second = rest.request("GET", "/users/@me", { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30);
    await Promise.all([occupied, second]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rest.stats).toEqual({ pending: 0, active: 0, waiting: 0 });
  });

  it("isolates URLs, queries, effective headers, authentication, and token updates", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) =>
      json({ auth: new Headers(init?.headers).get("Authorization") }));
    const rest = new RESTClient({ api, token: "old", fetch, coalesceGets: true });
    const route = "/channels/{channel_id}/messages";
    const requests = [
      rest.request("GET", route, { params: { channel_id: "10" }, query: { limit: "5" } }),
      rest.request("GET", route, { params: { channel_id: "10" }, query: { limit: "5" } }),
      rest.request("GET", route, { params: { channel_id: "11" }, query: { limit: "5" } }),
      rest.request("GET", route, { params: { channel_id: "10" }, query: { limit: "6" } }),
      rest.request("GET", route, { params: { channel_id: "10" }, query: { limit: "5" }, headers: { "X-Variant": "different" } }),
      rest.request("GET", route, { params: { channel_id: "10" }, query: { limit: "5" }, auth: false }),
    ];
    rest.updateToken("new");
    requests.push(rest.request("GET", route, { params: { channel_id: "10" }, query: { limit: "5" } }));
    const values = await Promise.all(requests);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(values[0]).toEqual({ auth: "Bot old" });
    expect(values[5]).toEqual({ auth: null });
    expect(values[6]).toEqual({ auth: "Bot new" });
  });

  it("does not share requests between REST clients", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json({}));
    const options = { api, token: "s", fetch, coalesceGets: true };
    await Promise.all([new RESTClient(options).request("GET", "/users/@me"), new RESTClient(options).request("GET", "/users/@me")]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves POST ordering and never shares writes", async () => {
    vi.useFakeTimers();
    let active = 0, peak = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return json(message());
    });
    const rest = new RESTClient({ api, token: "s", fetch, coalesceGets: true });
    const requests = Array.from({ length: 3 }, () => rest.request("POST", "/channels/{channel_id}/messages", {
      params: { channel_id: "10" }, body: { content: "same" }, coalesce: true,
    }));
    await vi.advanceTimersByTimeAsync(30);
    await Promise.all(requests);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  it("counts every caller against pending capacity", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return json({});
    });
    const rest = new RESTClient({ api, token: "s", fetch, coalesceGets: true, maxPendingRequests: 2 });
    const requests = [rest.request("GET", "/users/@me"), rest.request("GET", "/users/@me")];
    await expect(rest.request("GET", "/users/@me")).rejects.toBeInstanceOf(RequestQueueFullError);
    expect(rest.stats.pending).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(requests);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rest.stats.pending).toBe(0);
    const next = rest.request("GET", "/users/@me");
    await vi.advanceTimersByTimeAsync(10);
    await next;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cleans up failed shared requests and shares their retry budget", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ code: "UNAUTHORIZED" }, 401))
      .mockResolvedValueOnce(json({}, 503))
      .mockImplementation(async () => json({ id: "1" }));
    const rest = new RESTClient({ api, token: "s", fetch, coalesceGets: true, maxRetries: 1 });
    await Promise.all([0, 1].map(() => expect(rest.request("GET", "/users/@me")).rejects.toMatchObject({ status: 401 })));
    expect(fetch).toHaveBeenCalledTimes(1);
    const requests = [rest.request("GET", "/users/@me"), rest.request("GET", "/users/@me")];
    await vi.advanceTimersByTimeAsync(300);
    expect(await Promise.all(requests)).toEqual([{ id: "1" }, { id: "1" }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(rest.stats).toEqual({ pending: 0, active: 0, waiting: 0 });
  });

  it("shares a rate-limited retry without multiplying reservations or diagnostics", async () => {
    vi.useFakeTimers();
    const diagnostic = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ retry_after: 0.01, global: true }, 429))
      .mockImplementation(async () => json({ id: "1" }));
    const rest = new RESTClient({ api, token: "s", fetch, coalesceGets: true, maxRetries: 1, onDiagnostic: diagnostic });
    const requests = Array.from({ length: 10 }, () => rest.request("GET", "/users/@me"));
    await vi.advanceTimersByTimeAsync(9);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(requests);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(diagnostic.mock.calls.filter(([record]) => record.type === "rateLimit")).toHaveLength(1);
    expect(diagnostic.mock.calls.filter(([record]) => record.type === "response")).toHaveLength(2);
    expect(rest.stats).toEqual({ pending: 0, active: 0, waiting: 0 });
  });

  it("never shares GETs with a runtime request body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json({}));
    const rest = new RESTClient({ api, token: "s", fetch, coalesceGets: true });
    const requests = Array.from({ length: 2 }, () => rest.request("GET", "/users/@me", { body: { value: 1 } } as never));
    await Promise.all(requests);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns independent Blob responses and supports empty responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => new Response("binary", { headers: { "Content-Type": "application/octet-stream" } }))
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const rest = new RESTClient({ api, token: "s", fetch, coalesceGets: true });
    const blobs = await Promise.all([rest.request("GET", "/users/@me"), rest.request("GET", "/users/@me")]) as unknown as Blob[];
    expect(blobs[0]).not.toBe(blobs[1]);
    expect(await Promise.all(blobs.map(blob => blob.text()))).toEqual(["binary", "binary"]);
    expect(await Promise.all([rest.request("GET", "/users/@me"), rest.request("GET", "/users/@me")])).toEqual([undefined, undefined]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
