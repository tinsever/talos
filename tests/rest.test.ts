import { afterEach, describe, expect, it, vi } from "vitest";
import { RESTClient, FluxerAPIError } from "../src/rest.js";
import { json, message } from "./helpers.js";
const api = "https://public.example/api";
const route = "/channels/{channel_id}/messages" as const;
const params = { channel_id: "10" };
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("REST transport", () => {
  it("uses public API prefix, typed params, query, and bot auth", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json([]));
    await new RESTClient({ api, token: "secret", fetch }).request(
      "GET",
      route,
      { params, query: { limit: "25", before: "30" } },
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://public.example/api/v1/channels/10/messages?limit=25&before=30",
    );
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bot secret");
    expect(new Headers(init?.headers).get("Accept-Language")).toBe("en-US");
  });
  it("does not double append /v1", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}));
    await new RESTClient({ api: api + "/v1/", fetch }).request(
      "GET",
      "/auth/sso/status",
    );
    expect(String(fetch.mock.calls[0]![0])).toBe(api + "/v1/auth/sso/status");
  });
  it("encodes path values and audit reason", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json([]));
    await new RESTClient({ api, token: "s", fetch }).request("GET", route, {
      params: { channel_id: "a/b ?" },
      reason: "review ü",
    });
    expect(String(fetch.mock.calls[0]![0])).toContain(
      "/channels/a%2Fb%20%3F/messages",
    );
    expect(
      new Headers(fetch.mock.calls[0]![1]?.headers).get("X-Audit-Log-Reason"),
    ).toBe("review%20%C3%BC");
  });
  it("does not attach a token to public endpoints or caller supplied auth headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}));
    await new RESTClient({ api, token: "secret", fetch }).request(
      "GET",
      "/auth/sso/status",
      { headers: { Authorization: "oops" } },
    );
    expect(
      new Headers(fetch.mock.calls[0]![1]?.headers).has("Authorization"),
    ).toBe(false);
    expect(fetch.mock.calls[0]![1]?.redirect).toBe("error");
  });
  it("supports OAuth2 bearer and raw session tokens", async () => {
    for (const authScheme of ["Bearer", "Session"] as const) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(json({}));
      await new RESTClient({ api, token: "s", authScheme, fetch }).request(
        "GET",
        "/users/@me",
      );
      expect(
        new Headers(fetch.mock.calls[0]![1]?.headers).get("Authorization"),
      ).toBe(authScheme === "Bearer" ? "Bearer s" : "s");
    }
  });
  it("omits undefined JSON fields while retaining null", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(message()));
    await new RESTClient({ api, token: "s", fetch }).request("POST", route, {
      params,
      body: { content: null, nonce: undefined } as never,
    });
    expect(fetch.mock.calls[0]![1]?.body).toBe('{"content":null}');
  });
  it("passes multipart data without a JSON content type", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(message()));
    const body = new FormData();
    body.append("payload_json", "{}");
    await new RESTClient({ api, token: "s", fetch }).request("POST", route, {
      params,
      body,
      headers: { "Content-Type": "application/json" },
    });
    expect(fetch.mock.calls[0]![1]?.body).toBe(body);
    expect(
      new Headers(fetch.mock.calls[0]![1]?.headers).has("Content-Type"),
    ).toBe(false);
  });
  it("returns void for 204 and a typed API error for rejected credentials", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        json({ code: "UNAUTHORIZED", message: "Invalid credential" }, 401),
      );
    const rest = new RESTClient({ api, token: "secret", fetch });
    expect(
      await rest.request(
        "DELETE",
        "/channels/{channel_id}/messages/{message_id}",
        { params: { ...params, message_id: "20" } },
      ),
    ).toBeUndefined();
    await expect(rest.request("GET", "/users/@me")).rejects.toMatchObject({
      name: "FluxerAPIError",
      code: "UNAUTHORIZED",
      status: 401,
      route: "/users/@me",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects missing parameters, tokens, and traversal before fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const rest = new RESTClient({ api, fetch });
    await expect(
      rest.request("GET", route, { params: {} } as never),
    ).rejects.toThrow("Missing path");
    await expect(
      rest.request("GET", route, { params: { channel_id: ".." } }),
    ).rejects.toThrow("Invalid path");
    await expect(rest.request("GET", "/users/@me")).rejects.toThrow(
      "requires a token",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not retry potentially committed POST or PATCH on server/network errors", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockRejectedValueOnce(new TypeError("network"));
    const rest = new RESTClient({ api, token: "s", fetch });
    await expect(
      rest.request("POST", route, { params, body: { content: "hello" } }),
    ).rejects.toBeInstanceOf(FluxerAPIError);
    await expect(
      rest.request("PATCH", "/channels/{channel_id}/messages/{message_id}", {
        params: { ...params, message_id: "20" },
        body: { content: "edit" },
      }),
    ).rejects.toThrow("network");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels even an injected fetch that ignores signals", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = new RESTClient({ api, token: "s", fetch }).request(
      "GET",
      "/users/@me",
      { signal: controller.signal },
    );
    const assertion = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort(new Error("cancelled"));
    await assertion;
  });
  it("times out queued work without releasing its predecessor", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(json({}));
    const rest = new RESTClient({ api, token: "s", fetch, timeoutMs: 5_000 });
    const first = rest.request("GET", "/users/@me");
    const queued = rest.request("GET", "/users/@me", { timeoutMs: 10 });
    const assertion = expect(queued).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    const third = rest.request("GET", "/users/@me");
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch).toHaveBeenCalledTimes(1);
    release(json({}));
    await Promise.all([first, third]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("rate limits and retry budgets", () => {
  it("honors fractional body retry_after and retries a denied POST", async () => {
    vi.useFakeTimers();
    const diagnostic = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ retry_after: 0.25, global: false }, 429))
      .mockResolvedValueOnce(json(message()));
    const pending = new RESTClient({
      api,
      token: "s",
      fetch,
      onDiagnostic: diagnostic,
    }).request("POST", route, { params, body: { content: "hi" } });
    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "rateLimit",
        delayMs: 250,
        route,
        global: false,
      }),
    );
  });
  it("blocks other routes after a global 429", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ retry_after: 1, global: true }, 429))
      .mockImplementation(async () => json({}));
    const rest = new RESTClient({ api, token: "s", fetch });
    const first = rest.request("GET", "/users/@me");
    await vi.advanceTimersByTimeAsync(0);
    const second = rest.request("GET", "/auth/sso/status");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("waits proactively for exhausted buckets but allows unrelated resources", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (url) =>
        json(
          [],
          200,
          String(url).includes("/10/")
            ? {
                "X-RateLimit-Bucket": "a",
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset-After": "1",
              }
            : {},
        ),
      );
    const rest = new RESTClient({ api, token: "s", fetch });
    await rest.request("GET", route, { params });
    const blocked = rest.request("GET", route, { params });
    await rest.request("GET", route, { params: { channel_id: "11" } });
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await blocked;
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("coordinates routes that resolve to the same server bucket", async () => {
    vi.useFakeTimers();
    let remaining = 3;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        json({}, 200, {
          "X-RateLimit-Bucket": "shared",
          "X-RateLimit-Remaining": String(--remaining),
          "X-RateLimit-Reset-After": "1",
        }),
      );
    const rest = new RESTClient({ api, token: "s", fetch });
    await rest.request("GET", "/users/@me");
    await rest.request("GET", "/auth/sso/status");
    await rest.request("GET", "/users/@me");
    const blocked = rest.request("GET", "/auth/sso/status");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await blocked;
  });
  it("retries safe requests with bounded backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(json({}, 502))
      .mockResolvedValueOnce(json({}));
    const pending = new RESTClient({ api, token: "s", fetch }).request(
      "GET",
      "/users/@me",
    );
    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("terminates repeated 429s at the retry budget", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => json({ retry_after: 0.01 }, 429));
    const pending = new RESTClient({
      api,
      token: "s",
      fetch,
      maxRetries: 2,
    }).request("GET", "/users/@me");
    const assertion = expect(pending).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("keeps diagnostic events free of credentials and tolerates observer failures", async () => {
    const seen: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}));
    await new RESTClient({
      api,
      token: "TOP_SECRET",
      fetch,
      onDiagnostic: (event) => {
        seen.push(event);
        throw new Error("observer");
      },
    }).request("GET", "/users/@me");
    expect(JSON.stringify(seen)).not.toContain("TOP_SECRET");
  });
});
