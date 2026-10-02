import { snapshot } from "./snapshot.js";
import { collect } from "./collectors.js";
import type { CollectorOptions } from "./collectors.js";
import { LRUCache } from "./cache.js";
import { discover } from "./discovery.js";
import type { Instance } from "./discovery.js";
import { TypedEmitter } from "./events.js";
import { GatewayClient } from "./gateway.js";
import type { GatewayEvents, GatewayOptions } from "./gateway.js";
import { Message, Messages } from "./messages.js";
import { Uploads } from "./uploads.js";
import { Resources } from "./resources.js";
import type { ResourceCacheOptions } from "./resources.js";
import type { DispatchEvents, KnownDispatch } from "./gateway-types.js";
import { RESTClient } from "./rest.js";
import type { RESTOptions } from "./rest.js";
import type { MessageData, User } from "./types.js";
import { abortReason, positive } from "./utils.js";

export interface ClientEvents extends GatewayEvents {
  messageCreate: Message;
  /** Updates are partial API payloads and should not be treated as complete messages. */
  messageUpdate: Partial<MessageData> & { id: string; channel_id: string };
  messageDelete: { id: string; channel_id: string; guild_id?: string };
}
export interface ClientOptions {
  token: string;
  origin?: string;
  /** Supplying endpoints skips discovery. Always use api_public. */
  endpoints?: { api_public: string; gateway: string };
  rest?: Omit<RESTOptions, "api" | "token" | "authScheme">;
  gateway?: Omit<GatewayOptions, "url" | "token">;
  cache?: ResourceCacheOptions & { messages?: number };
}
export class Client extends TypedEmitter<ClientEvents> {
  private restClient: RESTClient | undefined;
  private uploadManager: Uploads | undefined;
  private resourceManager: Resources | undefined;
  private messageManager: Messages | undefined;
  private gatewayClient: GatewayClient | undefined;
  private active = false;
  private lifecycle: AbortController | undefined;
  private currentUser: User | undefined;
  private instanceData: Instance | undefined;
  readonly cache: LRUCache<string, Message>;
  get user(): User | undefined {
    return this.currentUser;
  }
  get instance(): Instance | undefined {
    return this.instanceData;
  }
  get rest(): RESTClient {
    if (!this.restClient)
      throw new Error("Connect the client before using REST");
    return this.restClient;
  }
  get messages(): Messages {
    if (!this.messageManager)
      throw new Error("Connect the client before using messages");
    return this.messageManager;
  }
  get gateway(): GatewayClient {
    if (!this.gatewayClient)
      throw new Error("Connect the client before using gateway");
    return this.gatewayClient;
  }

  get uploads(): Uploads {
    if (!this.uploadManager)
      throw new Error("Connect the client before using uploads");
    return this.uploadManager;
  }
  get resources(): Resources {
    if (!this.resourceManager)
      throw new Error("Connect the client before using resources");
    return this.resourceManager;
  }
  get users(): Resources["users"] {
    return this.resources.users;
  }
  get channels(): Resources["channels"] {
    return this.resources.channels;
  }
  get guilds(): Resources["guilds"] {
    return this.resources.guilds;
  }
  get invites(): Resources["invites"] {
    return this.resources.invites;
  }
  get webhooks(): Resources["webhooks"] {
    return this.resources.webhooks;
  }
  collect<K extends keyof ClientEvents>(
    event: K,
    options: CollectorOptions<ClientEvents[K]>,
  ): AsyncIterableIterator<ClientEvents[K]> {
    return collect(this, event, options);
  }
  onDispatch<K extends keyof DispatchEvents>(
    event: K,
    listener: (data: DispatchEvents[K]) => void | Promise<void>,
  ): () => void {
    return this.on("dispatch", (dispatch) => {
      if (dispatch.t === event)
        return listener(dispatch.d as DispatchEvents[K]);
    });
  }
  updateToken(token: string): void {
    if (!token || token.trim() !== token || /^(Bot|Bearer|Admin)\s/.test(token))
      throw new TypeError("A raw token without whitespace is required");
    this.restClient?.updateToken(token);
    this.gatewayClient?.updateToken(token);
    this.options.token = token;
  }

  constructor(private readonly options: ClientOptions) {
    super((error, event) => {
      if (event !== "error") this.emit("error", error);
    });
    if (
      !options.token ||
      options.token.trim() !== options.token ||
      /^(Bot|Bearer|Admin)\s/.test(options.token)
    )
      throw new TypeError(
        "token must be non-empty without surrounding whitespace",
      );
    this.cache = new LRUCache(
      options.cache?.messages ?? 0,
      options.cache?.ttlMs ?? 300_000,
    );
  }

  async connect(
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<void> {
    if (this.active)
      throw new Error("Client is already connected or connecting");
    options.signal?.throwIfAborted();
    const timeoutMs = positive(options.timeoutMs ?? 60_000, "timeoutMs");
    this.active = true;
    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    const abort = () => lifecycle.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        lifecycle.abort(
          new DOMException(
            "Client connection deadline exceeded",
            "TimeoutError",
          ),
        ),
      timeoutMs,
    );
    try {
      const instance = this.options.endpoints
        ? { endpoints: this.options.endpoints }
        : await discover(this.options.origin ?? "https://fluxer.app", {
            ...(this.options.rest?.fetch
              ? { fetch: this.options.rest.fetch }
              : {}),
            signal: lifecycle.signal,
          });
      lifecycle.signal.throwIfAborted();
      this.instanceData = instance;
      this.restClient = new RESTClient({
        ...(this.options.origin
          ? { origin: this.options.origin }
          : this.options.endpoints
            ? {}
            : { origin: "https://fluxer.app" }),
        ...this.options.rest,
        api: instance.endpoints.api_public,
        token: this.options.token,
      });
      this.uploadManager = new Uploads(
        this.rest,
        this.options.rest?.fetch ? { fetch: this.options.rest.fetch } : {},
      );
      this.resourceManager = new Resources(() => this.rest, this.options.cache);
      this.messageManager = this.resourceManager.messages;
      const gateway = new GatewayClient({
        ...this.options.gateway,
        url: instance.endpoints.gateway,
        token: this.options.token,
      });
      this.gatewayClient = gateway;
      gateway.on("ready", (data) => {
        if (this.gatewayClient !== gateway || !this.active) return;
        this.cache.clear();
        this.resources.apply({
          op: 0,
          t: "READY",
          s: 0,
          d: data as DispatchEvents["READY"],
        });
        this.currentUser = snapshot(data.user);
        this.emit("ready", data);
      });
      gateway.on("resumed", (value) => {
        if (this.gatewayClient === gateway && this.lifecycle === lifecycle)
          this.emit("resumed", value);
      });
      gateway.on("dispatch", (dispatch) => {
        if (this.gatewayClient !== gateway || !this.active) return;
        if (dispatch.t !== "READY")
          this.resources.apply(dispatch as KnownDispatch);
        this.emit("dispatch", dispatch);
        if (this.gatewayClient !== gateway || !this.active) return;
        if (dispatch.t === "MESSAGE_CREATE") {
          const data = dispatch.d as MessageData;
          const message = this.messages.wrap(data);
          this.cache.set(`${data.channel_id}:${data.id}`, message);
          this.emit("messageCreate", message);
        } else if (dispatch.t === "MESSAGE_UPDATE") {
          const data = dispatch.d as ClientEvents["messageUpdate"];
          const key = `${data.channel_id}:${data.id}`;
          const existing = this.cache.get(key);
          if (existing)
            this.cache.set(
              key,
              this.messages.wrap({ ...existing.data, ...data }),
            );
          this.emit("messageUpdate", data);
        } else if (dispatch.t === "MESSAGE_DELETE") {
          const data = dispatch.d as ClientEvents["messageDelete"];
          this.cache.delete(`${data.channel_id}:${data.id}`);
          this.emit("messageDelete", data);
        } else if (dispatch.t === "MESSAGE_DELETE_BULK") {
          const data = dispatch.d as { ids: string[]; channel_id: string };
          for (const id of data.ids)
            this.cache.delete(`${data.channel_id}:${id}`);
        }
      });
      gateway.on("state", (state) => {
        if (this.gatewayClient !== gateway || this.lifecycle !== lifecycle)
          return;
        if (state === "closed") {
          this.active = false;
          this.cache.clear();
          this.resourceManager?.clear();
          this.currentUser = undefined;
        }
        this.emit("state", state);
      });
      for (const event of [
        "error",
        "heartbeat",
        "reconnect",
        "close",
        "unknownOpcode",
      ] as const)
        gateway.on(event, (data) => {
          if (this.gatewayClient === gateway && this.lifecycle === lifecycle)
            this.emit(event, data);
        });
      await gateway.connect({ signal: lifecycle.signal, timeoutMs });
    } catch (error) {
      if (this.lifecycle === lifecycle) this.disconnect();
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  disconnect(): void {
    const lifecycle = this.lifecycle,
      gateway = this.gatewayClient;
    this.active = false;
    this.currentUser = undefined;
    this.cache.clear();
    this.resourceManager?.clear();
    lifecycle?.abort(new DOMException("Client disconnected", "AbortError"));
    if (this.lifecycle === lifecycle) gateway?.disconnect();
  }

  waitFor<K extends keyof ClientEvents>(
    event: K,
    predicate: (value: ClientEvents[K]) => boolean,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ClientEvents[K]> {
    const timeoutMs = positive(options.timeoutMs, "timeoutMs");
    if (options.signal?.aborted)
      return Promise.reject(abortReason(options.signal));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        off();
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(abortReason(options.signal!));
      };
      const off = this.on(event, (value) => {
        try {
          if (predicate(value)) {
            cleanup();
            resolve(value);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new DOMException(
            `Timed out waiting for ${String(event)}`,
            "TimeoutError",
          ),
        );
      }, timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
