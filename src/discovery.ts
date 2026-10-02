import { abortable, deadline, positive } from "./utils.js";
export interface Instance {
  endpoints: { api_public: string; gateway: string; [name: string]: string };
  features?: Record<string, boolean>;
  [name: string]: unknown;
}
export interface DiscoveryOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export async function discover(
  origin = "https://fluxer.app",
  options: DiscoveryOptions = {},
): Promise<Instance> {
  const url = new URL("/.well-known/fluxer", origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new TypeError(
      "Discovery requires an HTTP(S) origin without credentials",
    );
  const control = deadline(
    positive(options.timeoutMs ?? 15_000, "timeoutMs"),
    options.signal,
  );
  try {
    const response = await abortable(
      (options.fetch ?? globalThis.fetch)(url, {
        signal: control.signal,
        redirect: "follow",
        credentials: "omit",
      }),
      control.signal,
    );
    if (!response.ok)
      throw new Error(`Instance discovery returned HTTP ${response.status}`);
    const data: unknown = await abortable(response.json(), control.signal);
    if (
      !data ||
      typeof data !== "object" ||
      !("endpoints" in data) ||
      !data.endpoints ||
      typeof data.endpoints !== "object"
    )
      throw new TypeError("Invalid Fluxer discovery document");
    const endpoints = data.endpoints as Record<string, unknown>;
    for (const [name, protocols] of [
      ["api_public", ["http:", "https:"]],
      ["gateway", ["ws:", "wss:"]],
    ] as const) {
      const value = endpoints[name];
      if (typeof value !== "string")
        throw new TypeError(`Discovery is missing endpoints.${name}`);
      const endpoint = new URL(value);
      if (
        !(protocols as readonly string[]).includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw new TypeError(`Invalid endpoints.${name}`);
    }
    return data as Instance;
  } finally {
    control.dispose();
  }
}
