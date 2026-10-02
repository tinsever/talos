import { GatewayError } from "./errors.js";
import { TypedEmitter } from "./events.js";
import type { GatewayDispatch, ReadyData } from "./types.js";
import type { DispatchEvents } from "./gateway-types.js";
import { abortReason, positive } from "./utils.js";

export { GatewayError } from "./errors.js";
interface SocketEvents {
  message: { data: unknown };
  close: { code: number; reason: string };
  error: unknown;
}
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof SocketEvents>(
    type: K,
    listener: (event: SocketEvents[K]) => void,
  ): void;
  removeEventListener<K extends keyof SocketEvents>(
    type: K,
    listener: (event: SocketEvents[K]) => void,
  ): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;
export type GatewayState =
  | "idle"
  | "connecting"
  | "identifying"
  | "resuming"
  | "ready"
  | "reconnecting"
  | "closed";
export interface GatewayEvents {
  ready: ReadyData;
  resumed: void;
  dispatch: GatewayDispatch;
  state: GatewayState;
  error: unknown;
  heartbeat: { latencyMs: number };
  reconnect: { attempt: number; delayMs: number };
  close: { code: number; reason: string };
  unknownOpcode: number;
}
export interface GatewayOptions {
  url: string;
  token: string;
  webSocket?: WebSocketFactory;
  properties?: {
    os: string;
    browser: string;
    device: string;
    e2ee_capable?: boolean;
    mobile?: boolean;
    latitude?: string;
    longitude?: string;
  };
  ignoredEvents?: string[];
  shard?: readonly [number, number];
  maxReconnects?: number;
  handshakeTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Runs before every Identify, including fresh sessions after failed Resume. */
  beforeIdentify?: (context: {
    shard: readonly [number, number] | undefined;
    signal: AbortSignal;
  }) => Promise<void>;
  /** Ordered durable processing; sequences advance only after this hook resolves. */
  processDispatch?: (
    dispatch: GatewayDispatch,
    context: { signal: AbortSignal },
  ) => Promise<void>;
  maxPendingDispatches?: number;
}
const fatalCodes = new Set([4001, 4002, 4004, 4005, 4010, 4011, 4012]);

export class GatewayClient extends TypedEmitter<GatewayEvents> {
  private socket: WebSocketLike | undefined;
  private detach: (() => void) | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private awaitingAck: number | undefined;
  private sessionId: string | undefined;
  private sequence: number | null = null;
  private disconnectedAt: number | undefined;
  private attempts = 0;
  private stopped = true;
  private pending:
    | {
        resolve(data: ReadyData): void;
        reject(error: unknown): void;
        cleanup(): void;
      }
    | undefined;
  private readonly factory: WebSocketFactory;
  private readonly url: string;
  private readonly handshakeTimeout: number;
  private readonly reconnectBase: number;
  private readonly reconnectMax: number;
  private currentState: GatewayState = "idle";
  private generation = 0;
  private connectionControl: AbortController | undefined;
  private dispatchTail: Promise<void> = Promise.resolve();
  private queuedDispatches = 0;
  private readonly presenceUpdates: number[] = [];
  get state(): GatewayState {
    return this.currentState;
  }

  constructor(private readonly options: GatewayOptions) {
    super((error, event) => {
      if (event !== "error") this.emit("error", error);
    });
    const url = new URL(options.url);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password)
      throw new TypeError("gateway URL must use ws or wss without credentials");
    url.searchParams.set("v", "1");
    url.searchParams.set("encoding", "json");
    url.searchParams.set("compress", "none");
    url.searchParams.delete("stream");
    this.url = url.href;
    if (
      !options.token ||
      options.token.trim() !== options.token ||
      /^(Bot|Bearer|Admin)\s/.test(options.token)
    )
      throw new TypeError("Gateway requires a raw, non-empty token");
    if (
      options.properties &&
      (["os", "browser", "device"] as const).some(
        (key) => typeof options.properties![key] !== "string",
      )
    )
      throw new TypeError(
        "Identify properties os, browser, and device must be strings",
      );
    for (const key of ["latitude", "longitude"] as const) {
      const value = options.properties?.[key];
      if (
        value !== undefined &&
        (typeof value !== "string" || value.length < 1 || value.length > 32)
      )
        throw new TypeError(`${key} must be a string of 1..32 characters`);
    }
    this.factory =
      options.webSocket ??
      ((url) => {
        if (!globalThis.WebSocket)
          throw new GatewayError(
            "This runtime requires an injected webSocket factory (Node 22+ provides WebSocket)",
          );
        return new globalThis.WebSocket(url);
      });
    if (
      !Number.isInteger(options.maxPendingDispatches ?? 1000) ||
      (options.maxPendingDispatches ?? 1000) < 1
    )
      throw new RangeError("maxPendingDispatches must be positive");
    this.handshakeTimeout = positive(
      options.handshakeTimeoutMs ?? 30_000,
      "handshakeTimeoutMs",
    );
    this.reconnectBase = positive(
      options.reconnectBaseMs ?? 1_000,
      "reconnectBaseMs",
    );
    this.reconnectMax = positive(
      options.reconnectMaxMs ?? 30_000,
      "reconnectMaxMs",
    );
    if (
      options.maxReconnects !== undefined &&
      (!Number.isInteger(options.maxReconnects) || options.maxReconnects < 0)
    )
      throw new RangeError("maxReconnects must be a non-negative integer");
    if (
      options.ignoredEvents &&
      (options.ignoredEvents.length > 256 ||
        options.ignoredEvents.some((event) => typeof event !== "string"))
    )
      throw new TypeError("ignoredEvents must contain at most 256 strings");
    if (options.shard) {
      const [id, count] = options.shard;
      if (
        !Number.isInteger(id) ||
        !Number.isInteger(count) ||
        id < 0 ||
        count < 1 ||
        count > 16384 ||
        id >= count
      )
        throw new RangeError("Invalid shard pair");
    }
  }
  connect(
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ReadyData> {
    if (!this.stopped)
      return Promise.reject(new GatewayError("Gateway is already running"));
    if (options.signal?.aborted)
      return Promise.reject(abortReason(options.signal));
    const timeoutMs = positive(options.timeoutMs ?? 60_000, "timeoutMs");
    this.stopped = false;
    this.attempts = 0;
    this.generation++;
    return new Promise((resolve, reject) => {
      const abort = () => this.disconnect(abortReason(options.signal!));
      const timer = setTimeout(
        () =>
          this.disconnect(
            new GatewayError("Gateway connection deadline exceeded"),
          ),
        timeoutMs,
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        },
      };
      this.open();
    });
  }

  disconnect(error: unknown = new GatewayError("Gateway disconnected")): void {
    const generation = ++this.generation;
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.sessionId = undefined;
    this.sequence = null;
    this.disconnectedAt = undefined;
    this.presenceUpdates.length = 0;
    const pending = this.pending;
    this.pending = undefined;
    pending?.cleanup();
    pending?.reject(error);
    this.clearConnection();
    if (this.generation === generation) this.setState("closed");
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
      throw new TypeError("A raw token is required");
    this.options.token = token;
  }
  /** Presence changes exceeding the documented 5 per 20 seconds fail locally. */
  setPresence(data: {
    status: "online" | "idle" | "dnd" | "invisible";
    afk?: boolean;
    custom_status?: unknown;
  }): void {
    const now = Date.now();
    while (
      this.presenceUpdates[0] !== undefined &&
      this.presenceUpdates[0] <= now - 20_000
    )
      this.presenceUpdates.shift();
    if (this.presenceUpdates.length >= 5)
      throw new GatewayError("Presence update limit: 5 per 20 seconds");
    this.send(3, data);
    this.presenceUpdates.push(now);
  }
  /** Advanced protocol commands. Full dispatches are available through `dispatch`. */
  send(op: 3 | 4 | 8 | 14 | 15 | 16, data: unknown): void {
    if (this.state !== "ready") throw new GatewayError("Gateway is not ready");
    this.write(op, data);
  }

  private setState(state: GatewayState): void {
    this.currentState = state;
    this.emit("state", state);
  }
  private open(): void {
    if (this.stopped) return;
    const generation = this.generation;
    if (
      this.disconnectedAt !== undefined &&
      Date.now() - this.disconnectedAt >= 60_000
    ) {
      this.sessionId = undefined;
      this.sequence = null;
    }
    this.setState("connecting");
    if (this.stopped || this.generation !== generation) return;
    let socket: WebSocketLike;
    try {
      socket = this.factory(this.url);
    } catch (error) {
      this.fail(error);
      return;
    }
    if (this.stopped || this.generation !== generation) {
      this.closeSocket(socket);
      return;
    }
    this.socket = socket;
    this.connectionControl = new AbortController();
    const message = (event: SocketEvents["message"]) => {
      if (
        this.socket !== socket ||
        this.stopped ||
        this.generation !== generation
      )
        return;
      try {
        this.handle(event.data);
      } catch (error) {
        this.emit("error", error);
        if (this.generation === generation) this.restart();
      }
    };
    const close = (event: SocketEvents["close"]) => {
      if (
        this.socket !== socket ||
        this.stopped ||
        this.generation !== generation
      )
        return;
      this.emit("close", { code: event.code, reason: event.reason });
      if (this.stopped || this.generation !== generation) return;
      this.clearConnection();
      if (this.stopped || this.generation !== generation) return;
      if (fatalCodes.has(event.code)) {
        this.fail(
          new GatewayError(
            `Gateway closed: ${event.reason || event.code}`,
            event.code,
          ),
        );
        return;
      }
      if (event.code === 4003 || event.code === 4007) {
        this.sessionId = undefined;
        this.sequence = null;
      }
      this.scheduleReconnect();
    };
    const error = () => {
      if (
        this.socket !== socket ||
        this.stopped ||
        this.generation !== generation
      )
        return;
      this.emit("error", new GatewayError("WebSocket transport error"));
      if (this.generation !== generation) return;
      this.restart();
    };
    socket.addEventListener("message", message);
    socket.addEventListener("close", close);
    socket.addEventListener("error", error);
    this.detach = () => {
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", close);
      socket.removeEventListener("error", error);
    };
    this.handshakeTimer = setTimeout(() => {
      if (this.generation !== generation) return;
      this.emit("error", new GatewayError("Gateway handshake timed out"));
      if (this.generation === generation) this.restart();
    }, this.handshakeTimeout);
  }

  private write(op: number, d: unknown): void {
    if (!this.socket || this.socket.readyState !== 1)
      throw new GatewayError("WebSocket is not open");
    const frame = JSON.stringify({ op, d });
    if (new TextEncoder().encode(frame).length > 4096)
      throw new GatewayError("Gateway command exceeds 4096 bytes");
    this.socket.send(frame);
  }

  private identify(): void {
    const generation = this.generation,
      control = this.connectionControl;
    this.setState("identifying");
    if (
      this.stopped ||
      this.generation !== generation ||
      !control ||
      control.signal.aborted
    )
      return;
    const write = () => {
      if (
        this.stopped ||
        this.generation !== generation ||
        control.signal.aborted
      )
        return;
      this.write(2, {
        token: this.options.token,
        properties: this.options.properties ?? {
          os: "unknown",
          browser: "Talos",
          device: "Talos",
        },
        ...(this.options.ignoredEvents
          ? { ignored_events: this.options.ignoredEvents }
          : {}),
        ...(this.options.shard ? { shard: this.options.shard } : {}),
      });
    };
    if (!this.options.beforeIdentify) {
      write();
      return;
    }
    void Promise.resolve()
      .then(() =>
        this.options.beforeIdentify!({
          shard: this.options.shard,
          signal: control.signal,
        }),
      )
      .then(write)
      .catch((error) => {
        if (!control.signal.aborted && this.generation === generation)
          this.fail(error);
      });
  }
  private deliver(dispatch: GatewayDispatch): void {
    const control = this.connectionControl;
    if (!control) return;
    if (!this.options.processDispatch) {
      this.sequence = dispatch.s;
      this.emit("dispatch", dispatch);
      return;
    }
    if (this.queuedDispatches >= (this.options.maxPendingDispatches ?? 1000))
      throw new GatewayError("Dispatch processing queue is full");
    this.queuedDispatches++;
    this.dispatchTail = this.dispatchTail
      .then(async () => {
        if (control.signal.aborted) return;
        await this.options.processDispatch!(dispatch, {
          signal: control.signal,
        });
        if (control.signal.aborted) return;
        this.sequence = dispatch.s;
        this.emit("dispatch", dispatch);
      })
      .catch((error) => {
        if (!control.signal.aborted) {
          this.emit("error", error);
          if (!control.signal.aborted) this.restart();
        }
      })
      .finally(() => {
        if (this.connectionControl === control) this.queuedDispatches--;
      });
  }

  private handle(raw: unknown): void {
    const generation = this.generation;
    if (typeof raw !== "string")
      throw new GatewayError("Expected an uncompressed JSON text frame");
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new GatewayError("Invalid gateway JSON");
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      !("op" in payload) ||
      !Number.isInteger(payload.op)
    )
      throw new GatewayError("Invalid gateway payload");
    const frame = payload as {
      op: number;
      d?: unknown;
      s?: number;
      t?: string;
    };
    switch (frame.op) {
      case 10: {
        if (this.state !== "connecting")
          throw new GatewayError("Unexpected Hello");
        const interval = (
          frame.d as { heartbeat_interval?: unknown } | undefined
        )?.heartbeat_interval;
        if (typeof interval !== "number")
          throw new GatewayError("Invalid heartbeat interval");
        positive(interval, "heartbeat_interval");
        this.startHeartbeat(interval);
        if (this.sessionId && this.sequence !== null) {
          this.setState("resuming");
          if (this.stopped || this.generation !== generation) return;
          this.write(6, {
            token: this.options.token,
            session_id: this.sessionId,
            seq: this.sequence,
          });
        } else this.identify();
        break;
      }
      case 0: {
        if (
          typeof frame.t !== "string" ||
          frame.t.length === 0 ||
          !Number.isSafeInteger(frame.s) ||
          frame.s! < 0
        )
          throw new GatewayError("Invalid gateway dispatch");
        if (frame.t === "READY") {
          if (this.state !== "identifying" && this.state !== "resuming")
            throw new GatewayError("Unexpected READY");
          const ready = frame.d as ReadyData;
          if (
            !ready ||
            typeof ready.session_id !== "string" ||
            ready.session_id.length === 0 ||
            !ready.user ||
            typeof ready.user.id !== "string" ||
            ready.user.id.length === 0
          )
            throw new GatewayError("Invalid READY data");
          this.sessionId = ready.session_id;
          if (!this.options.processDispatch) this.sequence = frame.s!;
          this.markReady();
          if (this.stopped || this.generation !== generation) return;
          this.emit("ready", ready);
          if (this.stopped || this.generation !== generation) return;
          this.pending?.cleanup();
          this.pending?.resolve(ready);
          this.pending = undefined;
        } else if (frame.t === "RESUMED") {
          if (this.state !== "resuming")
            throw new GatewayError("Unexpected RESUMED");
          this.markReady();
          if (this.stopped || this.generation !== generation) return;
          this.emit("resumed", undefined);
          if (this.stopped || this.generation !== generation) return;
        }
        this.deliver(frame as GatewayDispatch);
        break;
      }
      case 1:
        this.heartbeat();
        break;
      case 11:
        {
          const sent = this.awaitingAck;
          this.awaitingAck = undefined;
          if (sent !== undefined)
            this.emit("heartbeat", { latencyMs: Date.now() - sent });
        }
        break;
      case 7:
        this.restart();
        break;
      case 9:
        if (this.state === "connecting")
          throw new GatewayError("Invalid Session before Hello");
        this.sessionId = undefined;
        this.sequence = null;
        // A rejected Resume leaves this socket unauthenticated; Identify on it.
        this.identify();
        break;
      default:
        this.emit("unknownOpcode", frame.op);
    }
  }

  private markReady(): void {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.attempts = 0;
    this.disconnectedAt = undefined;
    this.setState("ready");
  }
  private startHeartbeat(interval: number): void {
    const generation = this.generation;
    const tick = () => {
      if (this.stopped || !this.socket || this.generation !== generation)
        return;
      if (
        this.awaitingAck !== undefined &&
        Date.now() - this.awaitingAck >= interval
      ) {
        this.emit("error", new GatewayError("Heartbeat ACK timed out"));
        if (this.generation === generation) this.restart();
        return;
      }
      try {
        this.heartbeat();
      } catch (error) {
        this.emit("error", error);
        if (this.generation === generation) this.restart();
        return;
      }
      if (!this.stopped && this.generation === generation)
        this.heartbeatTimer = setTimeout(tick, interval);
    };
    this.heartbeatTimer = setTimeout(tick, Math.random() * interval);
  }
  private heartbeat(): void {
    this.awaitingAck ??= Date.now();
    this.write(1, this.sequence);
  }
  private clearConnection(): void {
    const control = this.connectionControl,
      socket = this.socket,
      detach = this.detach;
    this.connectionControl = undefined;
    this.dispatchTail = Promise.resolve();
    this.queuedDispatches = 0;
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.awaitingAck = undefined;
    this.socket = undefined;
    this.detach = undefined;
    detach?.();
    this.closeSocket(socket);
    control?.abort(new GatewayError("Gateway transport closed"));
  }
  private closeSocket(socket: WebSocketLike | undefined): void {
    // ws needs an error listener while cancellation interrupts the HTTP upgrade.
    let cleanupClosing: (() => void) | undefined;
    if (socket?.readyState === 0) {
      const ignoreError = () => {};
      const closed = () => {
        socket.removeEventListener("error", ignoreError);
        socket.removeEventListener("close", closed);
      };
      socket.addEventListener("error", ignoreError);
      socket.addEventListener("close", closed);
      cleanupClosing = closed;
    }
    try {
      socket?.close(1000, "Talos disconnect");
    } catch {
      cleanupClosing?.();
    }
  }

  private restart(): void {
    if (this.stopped) return;
    const generation = this.generation;
    this.clearConnection();
    if (this.generation === generation) this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const generation = this.generation;
    this.disconnectedAt ??= Date.now();
    if (this.attempts >= (this.options.maxReconnects ?? 20)) {
      this.fail(new GatewayError("Gateway reconnect budget exhausted"));
      return;
    }
    const wait =
      Math.min(
        this.reconnectMax,
        this.reconnectBase * 2 ** Math.min(this.attempts, 30),
      ) *
      (0.5 + Math.random() * 0.5);
    this.attempts++;
    this.setState("reconnecting");
    if (this.stopped || this.generation !== generation) return;
    this.emit("reconnect", { attempt: this.attempts, delayMs: wait });
    if (this.stopped || this.generation !== generation) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.generation === generation) this.open();
    }, wait);
  }
  private fail(error: unknown): void {
    const generation = this.generation;
    this.emit("error", error);
    if (this.generation === generation) this.disconnect(error);
  }
}
