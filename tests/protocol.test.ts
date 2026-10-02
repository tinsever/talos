import { afterEach, describe, expect, it, vi } from "vitest";
import { RESTClient } from "../src/rest.js";
import { discover } from "../src/discovery.js";
import { json } from "./helpers.js";
afterEach(() => {
  vi.useRealTimers();
});
describe("protocol edge cases", () => {
  it("applies the documented gateway/bot auth override", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ url: "wss://example", shards: 1 }));
    await new RESTClient({
      api: "https://api.example",
      token: "1.secret",
      fetch,
    }).request("GET", "/gateway/bot");
    expect(
      new Headers(fetch.mock.calls[0]![1]?.headers).get("Authorization"),
    ).toBe("Bot 1.secret");
  });
  it("requests discovery on the instance origin without a version or token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}));
    await new RESTClient({
      api: "https://public.example/api",
      origin: "https://instance.example",
      token: "s",
      fetch,
    }).request("GET", "/.well-known/fluxer");
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://instance.example/.well-known/fluxer",
    );
    expect(
      new Headers(fetch.mock.calls[0]![1]?.headers).has("Authorization"),
    ).toBe(false);
  });
  it("supports binary response routes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response("archive bytes", {
          headers: { "Content-Type": "application/zip" },
        }),
      );
    const result = await new RESTClient({
      api: "https://example",
      fetch,
    }).request("GET", "/harvest-downloads/{harvestId}", {
      params: { harvestId: "1" },
    });
    expect(result).toBeInstanceOf(Blob);
    expect(await result.text()).toBe("archive bytes");
  });
  it("honors Retry-After when rate-limit response body is plain text", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("limited", {
          status: 429,
          headers: { "Retry-After": "1", "X-RateLimit-Global": "true" },
        }),
      )
      .mockResolvedValueOnce(json({}));
    const pending = new RESTClient({ api: "https://example", fetch }).request(
      "GET",
      "/auth/sso/status",
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels a rate-limit wait immediately", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ retry_after: 60 }, 429));
    const pending = new RESTClient({ api: "https://example", fetch }).request(
      "GET",
      "/auth/sso/status",
      { signal: controller.signal },
    );
    const assertion = expect(pending).rejects.toThrow("stop");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("stop"));
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("applies the request deadline while the response body stalls", async () => {
    vi.useFakeTimers();
    const response = json({});
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const pending = new RESTClient({
      api: "https://example",
      fetch,
      timeoutMs: 10,
    }).request("GET", "/auth/sso/status");
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
  it("does not start a request with an already aborted signal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(
      new RESTClient({ api: "https://example", fetch }).request(
        "GET",
        "/auth/sso/status",
        { signal },
      ),
    ).rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses invalid discovery protocols and a missing public endpoint", async () => {
    for (const endpoints of [
      { api_public: "file:///tmp/file", gateway: "wss://example" },
      { api_public: "https://example", gateway: "https://example" },
    ]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(json({ endpoints }));
      await expect(discover("https://example", { fetch })).rejects.toThrow(
        "Invalid endpoints",
      );
    }
  });
  it("rejects invalid retry/cache/deadline configuration", () => {
    expect(
      () => new RESTClient({ api: "https://example", maxBuckets: 0 }),
    ).toThrow("maxBuckets");
    expect(
      () => new RESTClient({ api: "https://example", maxRetries: -1 }),
    ).toThrow("maxRetries");
    expect(
      () => new RESTClient({ api: "https://example", timeoutMs: Infinity }),
    ).toThrow("timeoutMs");
    expect(
      () => new RESTClient({ api: "https://user:password@example" }),
    ).toThrow("without credentials");
  });
});
